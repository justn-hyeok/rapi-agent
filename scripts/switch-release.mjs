import { execFile } from "node:child_process";
import { parseEnv, promisify } from "node:util";
import {
  lstat,
  readlink,
  realpath,
  symlink,
  rename,
  unlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { verifyRelease } from "./release-artifact.mjs";

const execute = promisify(execFile);
const ports = { bot: 3000, chat: 3100, omp: 3200, monitor: 3300, worker: 3400 };

export function configuredHealthPorts(environment) {
  const keys = {
    bot: "PORT",
    chat: "CHAT_HEALTH_PORT",
    omp: "OMP_PORT",
    monitor: "MONITOR_PORT",
    worker: "WORKER_HEALTH_PORT",
  };
  return Object.fromEntries(
    Object.entries(keys).map(([service, key]) => {
      const port = Number(environment[key] ?? ports[service]);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error(`Invalid configured health port: ${key}`);
      return [service, port];
    }),
  );
}

// The driver owns draining, starting and observing exact services. Tests use
// real disposable child processes; production uses the bounded systemd driver.
export async function switchRelease({
  currentPath,
  candidatePath,
  expectedSha,
  services,
  driver,
  receiptPath,
  schemaMigration,
}) {
  if (
    !services.length ||
    new Set(services).size !== services.length ||
    services.some((name) => !Object.hasOwn(ports, name)) ||
    !services.includes("bot")
  )
    throw new Error("Explicit supported service set must include bot");
  if (!/^[a-f0-9]{40}$/.test(expectedSha))
    throw new Error("Full candidate SHA is required");
  currentPath = resolve(currentPath);
  candidatePath = resolve(candidatePath);
  if (
    currentPath === candidatePath ||
    !(await lstat(currentPath)).isSymbolicLink()
  )
    throw new Error("Current release must be an existing symlink");
  if ((await realpath(dirname(currentPath))) !== dirname(currentPath))
    throw new Error("Current pointer directory must be canonical");
  const candidate = await verifyRelease(candidatePath, expectedSha);
  const previousPath = await realpath(currentPath);
  const previous = await verifyRelease(previousPath);
  if (candidate.sha === previous.sha)
    throw new Error("Candidate is already current");
  const added = candidate.migrations.filter(
    (name) => !previous.migrations.includes(name),
  );
  const removed = previous.migrations.filter(
    (name) => !candidate.migrations.includes(name),
  );
  if (
    JSON.stringify(previous.migrations) !==
      JSON.stringify(candidate.migrations) &&
    (!schemaMigration ||
      removed.length ||
      JSON.stringify(added) !== JSON.stringify(schemaMigration.namesAdded))
  )
    throw new Error(
      "Previous release schema compatibility has not been established",
    );
  const originalLink = await readlink(currentPath);
  const lockPath = `${currentPath}.switch-lock`;
  const lock = await import("node:fs/promises").then(({ open }) =>
    open(lockPath, "wx"),
  );
  const receipt = {
    candidate: candidate.sha,
    previous: previous.sha,
    services,
    startedAt: new Date().toISOString(),
    status: "preparing",
    rollback: null,
  };
  let active = [];
  let switched = false;
  let touched = false;
  let migrationAttempted = false;
  const point = async (target) => {
    const temporary = join(
      dirname(currentPath),
      `.rapi-pointer-${randomUUID()}`,
    );
    await symlink(target, temporary);
    try {
      await rename(temporary, currentPath);
    } catch (error) {
      await unlink(temporary);
      throw error;
    }
  };
  try {
    if ((await readlink(currentPath)) !== originalLink)
      throw new Error("Current pointer changed during preparation");
    active = await driver.active(services);
    if (active.some((name) => !services.includes(name)))
      throw new Error("Driver returned an unexpected service");
    if (!active.includes("bot"))
      throw new Error(
        "Previous bot must be running and verifiable before switching",
      );
    await driver.ready(active, previous.sha);
    // Persist recovery coordinates before stopping any service.
    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...receipt, active, previousPath, candidatePath }, null, 2)}\n`,
      { flag: "wx" },
    );
    touched = true;
    await driver.stop(active);
    await point(candidatePath);
    switched = true;
    if (schemaMigration && added.length) {
      migrationAttempted = true;
      await schemaMigration.upgrade();
    }
    await driver.start(active);
    await driver.ready(active, candidate.sha);
    receipt.status = "switched";
  } catch (error) {
    receipt.status = "failed";
    receipt.error = error instanceof Error ? error.message : "switch failed";
    if (touched) {
      try {
        // A failed start can leave a partial set running. Drain it before rollback.
        await driver.stop(active);
        if (migrationAttempted) await schemaMigration.rollback();
        if (switched) await point(previousPath);
        await driver.start(active);
        await driver.ready(active, previous.sha);
        receipt.rollback = "verified";
      } catch (rollbackError) {
        receipt.rollback = "failed";
        receipt.rollbackError =
          rollbackError instanceof Error
            ? rollbackError.message
            : "rollback failed";
      }
    }
    throw new Error(
      `Release switch failed; rollback ${receipt.rollback ?? "not needed"}: ${receipt.error}`,
      { cause: error },
    );
  } finally {
    try {
      if (touched)
        await writeFile(
          receiptPath,
          `${JSON.stringify({ ...receipt, active, previousPath, candidatePath, finishedAt: new Date().toISOString() }, null, 2)}\n`,
        );
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
  return receipt;
}

// These units Require= rapi-bot (directly or through the gateway), so stopping
// bot stops them too. They are not switched themselves and must come back.
const dependentUnits = ["rapi-public-gateway.service", "rapi-tunnel.service"];

export function systemdDriver(
  endpointPorts = configuredHealthPorts(process.env),
  maximumAttempts = 30,
  run = (args) =>
    execute("systemctl", args, { timeout: 60_000, maxBuffer: 64_000 }),
) {
  const unit = (name) => `rapi-${name}.service`;
  let stoppedDependents = [];
  return {
    async active(services) {
      const active = [];
      for (const name of services) {
        const { stdout } = await run([
          "show",
          unit(name),
          "--property=ActiveState",
          "--value",
        ]);
        if (stdout.trim() === "active") active.push(name);
        else if (stdout.trim() !== "inactive")
          throw new Error(`Service ${name} is not in a stable state`);
      }
      return active;
    },
    async stop(services) {
      const running = [];
      for (const name of dependentUnits) {
        const { stdout } = await run([
          "show",
          name,
          "--property=ActiveState",
          "--value",
        ]);
        if (stdout.trim() === "active") running.push(name);
      }
      stoppedDependents = [...new Set([...stoppedDependents, ...running])];
      await run(["stop", ...services.map(unit)]);
    },
    async start(services) {
      await run(["start", ...services.map(unit), ...stoppedDependents]);
    },
    async ready(services, sha) {
      // Unit drop-ins must already point WorkingDirectory at the current symlink.
      // Boot-captured revision plus readiness is required, never on-disk HEAD.
      for (let attempt = 0; attempt < maximumAttempts; attempt++) {
        let ready = true;
        for (const name of services) {
          try {
            const response = await fetch(
              `http://127.0.0.1:${endpointPorts[name]}/${name === "monitor" ? "health" : "ready"}`,
              { signal: AbortSignal.timeout(1500) },
            );
            const body = await response.json();
            const healthy =
              name === "monitor" ? body.status === "ok" : body.ready === true;
            if (!response.ok || !healthy || body.revision !== sha)
              ready = false;
          } catch {
            ready = false;
          }
        }
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Loaded revision or service readiness does not match");
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.env.RAPI_SWITCH_APPROVED !== "true")
    throw new Error(
      "Explicit operational approval is required before switching services",
    );
  const {
    RAPI_CURRENT_RELEASE,
    RAPI_CANDIDATE_RELEASE,
    RAPI_RELEASE_SHA,
    RAPI_SWITCH_RECEIPT,
    RAPI_SWITCH_SERVICES,
    RAPI_SERVICE_ENV_FILE,
  } = process.env;
  if (
    !RAPI_CURRENT_RELEASE ||
    !RAPI_CANDIDATE_RELEASE ||
    !RAPI_RELEASE_SHA ||
    !RAPI_SWITCH_RECEIPT ||
    !RAPI_SWITCH_SERVICES ||
    !RAPI_SERVICE_ENV_FILE
  )
    throw new Error(
      "Explicit release paths, SHA, receipt, services and service environment file are required",
    );
  await switchRelease({
    currentPath: RAPI_CURRENT_RELEASE,
    candidatePath: RAPI_CANDIDATE_RELEASE,
    expectedSha: RAPI_RELEASE_SHA,
    receiptPath: RAPI_SWITCH_RECEIPT,
    services: RAPI_SWITCH_SERVICES.split(","),
    driver: systemdDriver(
      configuredHealthPorts(
        parseEnv(await readFile(RAPI_SERVICE_ENV_FILE, "utf8")),
      ),
    ),
  });
}
