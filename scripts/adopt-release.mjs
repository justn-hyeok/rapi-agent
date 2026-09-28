import {
  lstat,
  open,
  symlink,
  unlink,
  writeFile,
  realpath,
  readFile,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { verifyRelease } from "./release-artifact.mjs";
import { installReleaseUnits } from "./release-units.mjs";
import { configuredHealthPorts, systemdDriver } from "./switch-release.mjs";
import { execFile } from "node:child_process";
import { parseEnv, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";

// First deployment only. A legacy checkout has no sealed predecessor, so its
// observed process/unit state is explicitly separate from normal sealed switches.
export async function adoptRelease({
  currentPath,
  candidatePath,
  expectedSha,
  receiptPath,
  driver,
  wiringReceiptPath,
}) {
  currentPath = resolve(currentPath);
  candidatePath = resolve(candidatePath);
  if (!/^[a-f0-9]{40}$/.test(expectedSha))
    throw new Error("Full candidate SHA required");
  wiringReceiptPath = resolve(wiringReceiptPath);
  receiptPath = resolve(receiptPath);
  if (wiringReceiptPath === receiptPath)
    throw new Error("Distinct adoption and unit receipt paths required");
  try {
    await lstat(wiringReceiptPath);
    throw new Error("Fresh unit receipt path required");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if ((await realpath(dirname(currentPath))) !== dirname(currentPath))
    throw new Error("Canonical release pointer directory required");
  try {
    await lstat(currentPath);
    throw new Error("Initial adoption requires an absent current pointer");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const candidate = await verifyRelease(candidatePath, expectedSha);
  const lockPath = `${currentPath}.adopt-lock`;
  const lock = await open(lockPath, "wx");
  let legacy;
  let touched = false;
  let pointed = false;
  const attemptId = randomUUID();
  const receipt = {
    candidate: candidate.sha,
    status: "preparing",
    rollback: null,
    predecessorEvidence:
      "legacy process/unit observation; no sealed revision claim",
    attemptId,
  };
  try {
    legacy = await driver.snapshot();
    if (
      !Array.isArray(legacy.active) ||
      !legacy.active.includes("bot") ||
      new Set(legacy.active).size !== legacy.active.length ||
      legacy.active.some(
        (name) => !["bot", "chat", "omp", "monitor", "worker"].includes(name),
      )
    )
      throw new Error("Invalid legacy service set");
    if (
      !Array.isArray(legacy.appliedMigrations) ||
      JSON.stringify([...legacy.appliedMigrations].sort()) !==
        JSON.stringify(candidate.migrations)
    )
      throw new Error(
        "Production schema differs from candidate; adoption cannot migrate or prove rollback compatibility",
      );
    await driver.legacyReady(legacy.active);
    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...receipt, legacy }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    touched = true;
    await driver.stop(legacy.active);
    await symlink(candidatePath, currentPath);
    pointed = true;
    await driver.wire(attemptId);
    await driver.start(legacy.active);
    await driver.ready(legacy.active, candidate.sha);
    receipt.status = "adopted";
  } catch (error) {
    receipt.status = "failed";
    receipt.error = error instanceof Error ? error.message : "adoption failed";
    if (touched) {
      try {
        await driver.stop(legacy.active);
        await driver.restore(attemptId);
        if (pointed) await unlink(currentPath);
        await driver.start(legacy.active);
        await driver.legacyReady(legacy.active);
        receipt.rollback = "legacy runtime restored";
      } catch (rollbackError) {
        receipt.rollback = "failed";
        receipt.rollbackError =
          rollbackError instanceof Error
            ? rollbackError.message
            : "rollback failed";
      }
    }
    throw new Error(
      `Initial adoption failed; rollback ${receipt.rollback ?? "not needed"}: ${receipt.error}`,
      { cause: error },
    );
  } finally {
    try {
      if (touched)
        await writeFile(
          receiptPath,
          `${JSON.stringify({ ...receipt, legacy, finishedAt: new Date().toISOString() }, null, 2)}\n`,
          { mode: 0o600 },
        );
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.env.RAPI_ADOPT_APPROVED !== "true")
    throw new Error("Explicit first-deployment approval required");
  const {
    RAPI_CURRENT_RELEASE: currentPath,
    RAPI_CANDIDATE_RELEASE: candidatePath,
    RAPI_RELEASE_SHA: expectedSha,
    RAPI_ADOPT_RECEIPT: receiptPath,
    RAPI_SERVICE_ENV_FILE: environmentPath,
    RAPI_LEGACY_APP_ROOT: legacyAppRoot,
    RAPI_RELEASE_UNITS_RECEIPT: unitReceipt,
  } = process.env;
  if (
    ![
      currentPath,
      candidatePath,
      expectedSha,
      receiptPath,
      environmentPath,
      legacyAppRoot,
      unitReceipt,
    ].every(Boolean)
  )
    throw new Error(
      "Explicit candidate, pointer, legacy root, environment and recovery receipts required",
    );
  const run = promisify(execFile);
  const serviceEnvironment = parseEnv(await readFile(environmentPath, "utf8"));
  const ports = configuredHealthPorts(serviceEnvironment);
  const serviceDriver = systemdDriver(ports);
  const reload = () => run("systemctl", ["daemon-reload"], { timeout: 30_000 });
  const units = Object.keys(ports);
  const driver = {
    ...serviceDriver,
    async snapshot() {
      const active = await serviceDriver.active(units);
      const services = {};
      for (const name of active) {
        const { stdout } = await run(
          "systemctl",
          [
            "show",
            `rapi-${name}.service`,
            "--property=WorkingDirectory,MainPID",
          ],
          { timeout: 5000 },
        );
        const state = Object.fromEntries(
          stdout
            .trim()
            .split("\n")
            .map((line) => {
              const i = line.indexOf("=");
              return [line.slice(0, i), line.slice(i + 1)];
            }),
        );
        if (
          state.WorkingDirectory !== legacyAppRoot ||
          !(Number(state.MainPID) > 0)
        )
          throw new Error(`Legacy process identity differs for ${name}`);
        services[name] = state;
      }
      const { stdout: sha } = await run(
        "git",
        ["-C", legacyAppRoot, "rev-parse", "HEAD"],
        { timeout: 5000 },
      );
      const client = new pg.Client({
        connectionString: serviceEnvironment.DATABASE_URL,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
      });
      await client.connect();
      let appliedMigrations;
      try {
        const result = await client.query(
          "SELECT name FROM schema_migrations ORDER BY name",
        );
        appliedMigrations = result.rows.map((row) => row.name);
      } finally {
        await client.end();
      }
      return {
        active,
        services,
        legacyAppRoot,
        checkoutSha: sha.trim(),
        appliedMigrations,
      };
    },
    async legacyReady(services) {
      for (let attempt = 0; attempt < 30; attempt++) {
        let ready = true;
        for (const name of services) {
          try {
            const response = await fetch(
              `http://127.0.0.1:${ports[name]}/${name === "monitor" ? "health" : "ready"}`,
              { signal: AbortSignal.timeout(1500) },
            );
            const body = await response.json();
            if (
              !response.ok ||
              (name === "monitor" ? body.status !== "ok" : body.ready !== true)
            )
              ready = false;
          } catch {
            ready = false;
          }
        }
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Legacy runtime readiness failed");
    },
    async wire(attemptId) {
      await installReleaseUnits({
        currentPath,
        environmentPath,
        nodeBinary: process.env.RAPI_NODE_BINARY ?? process.execPath,
        unitRoot: "/etc/systemd/system",
        receiptPath: unitReceipt,
        reload,
        attemptId,
      });
    },
    async restore(attemptId) {
      let receipt;
      try {
        receipt = JSON.parse(await readFile(unitReceipt, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (receipt.attemptId !== attemptId) return;
      for (const [unit, content] of Object.entries(receipt.before)) {
        if (!units.some((name) => unit === `rapi-${name}.service`))
          throw new Error("Unexpected rollback unit");
        const target = `/etc/systemd/system/${unit}.d/10-rapi-release.conf`;
        if (receipt.targets[unit] !== target)
          throw new Error("Unexpected rollback path");
        if (content === null)
          await unlink(target).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        else if (typeof content === "string") await writeFile(target, content);
        else throw new Error("Invalid rollback content");
      }
      await reload();
    },
  };
  await adoptRelease({
    currentPath,
    candidatePath,
    expectedSha,
    receiptPath,
    driver,
    wiringReceiptPath: unitReceipt,
  });
  process.stdout.write("Initial release adoption verified\n");
}
