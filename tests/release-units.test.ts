import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  realpath,
  rm,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  installReleaseUnits,
  releaseUnitContents,
} from "../scripts/release-units.mjs";
import {
  configuredHealthPorts,
  systemdDriver,
} from "../scripts/switch-release.mjs";
import { parseEnv } from "node:util";

test("release verification reads every supported port override from the service environment", () => {
  const environment = parseEnv(
    'PORT=4100\nCHAT_HEALTH_PORT="4101"\nOMP_PORT=4102\nMONITOR_PORT=4103\nWORKER_HEALTH_PORT=4104\n',
  );
  assert.deepEqual(configuredHealthPorts(environment), {
    bot: 4100,
    chat: 4101,
    omp: 4102,
    monitor: 4103,
    worker: 4104,
  });
  assert.equal(configuredHealthPorts({}).bot, 3000);
  assert.throws(() => configuredHealthPorts({ PORT: "70000" }), /Invalid/);
  assert.throws(
    () => configuredHealthPorts({ MONITOR_PORT: "not-a-port" }),
    /Invalid/,
  );
});

test("release unit wiring starts the staged code with an external environment and restores failed configuration", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rapi-unit-")));
  let child: ChildProcess | undefined;
  try {
    const stage = join(root, "release");
    await mkdir(join(stage, "apps/bot/src"), { recursive: true });
    await writeFile(
      join(stage, "apps/bot/src/run.ts"),
      'process.stdout.write(JSON.stringify({cwd:process.cwd(),marker:process.env.RAPI_UNIT_MARKER})+"\\n");\n',
    );
    await symlink(resolve("node_modules"), join(stage, "node_modules"));
    const currentPath = join(root, "current");
    await symlink(stage, currentPath);
    const environmentPath = join(root, "service.env");
    await writeFile(environmentPath, "RAPI_UNIT_MARKER=external-config\n");
    const options = {
      currentPath,
      environmentPath,
      nodeBinary: process.execPath,
    };
    const contents = releaseUnitContents(options);
    const bot = contents["rapi-bot.service"]!;
    const command = /^ExecStart=(.+)$/m.exec(bot)![1]!.split(" ");
    assert.ok(bot.includes("ExecStart=\n"));
    child = spawn(command[0]!, command.slice(1), {
      cwd: currentPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const [code] = (await once(child, "close")) as [number | null];
    child = undefined;
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), {
      cwd: stage,
      marker: "external-config",
    });

    const unitRoot = join(root, "systemd");
    const target = join(unitRoot, "rapi-bot.service.d/10-rapi-release.conf");
    await mkdir(join(unitRoot, "rapi-bot.service.d"), { recursive: true });
    await writeFile(target, "previous drop-in\n");
    let reloads = 0;
    await assert.rejects(
      installReleaseUnits({
        ...options,
        unitRoot,
        receiptPath: join(root, "failed.json"),
        async reload() {
          reloads++;
          if (reloads === 1) throw new Error("daemon reload failed");
        },
      }),
      /daemon reload failed/,
    );
    assert.equal(await readFile(target, "utf8"), "previous drop-in\n");
    await installReleaseUnits({
      ...options,
      unitRoot,
      receiptPath: join(root, "installed.json"),
      async reload() {},
    });
    assert.equal(await readFile(target, "utf8"), bot);
    assert.throws(
      () =>
        releaseUnitContents({
          ...options,
          currentPath: "/tmp/invalid\nExecStart=other",
        }),
      /canonical/,
    );
  } finally {
    if (child) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("monitor revision preflight tolerates a down contained worker while bot readiness remains required", async () => {
  const sha = "a".repeat(40);
  let revision = sha;
  let botReady = true;
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok", revision }));
      return;
    }
    response.writeHead(botReady ? 200 : 503);
    response.end(JSON.stringify({ ready: botReady, revision }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const driver = systemdDriver({ monitor: address.port, bot: address.port }, 1);
  try {
    // The monitor uses liveness+revision; its dependency readiness can be 503.
    botReady = false;
    await driver.ready(["monitor"], sha);
    await assert.rejects(driver.ready(["bot"], sha), /readiness/);
    botReady = true;
    await driver.ready(["bot", "monitor"], sha);
    revision = "b".repeat(40);
    await assert.rejects(driver.ready(["monitor"], sha), /revision/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("systemd driver restarts dependents that stopping bot took down", async () => {
  const calls: string[][] = [];
  const states: Record<string, string> = {
    "rapi-public-gateway.service": "active",
    "rapi-tunnel.service": "inactive",
  };
  const driver = systemdDriver({ bot: 1 }, 1, async (args) => {
    calls.push(args);
    return { stdout: args[0] === "show" ? `${states[args[1]!] ?? ""}\n` : "" };
  });
  await driver.stop(["bot", "worker"]);
  await driver.start(["bot", "worker"]);
  assert.deepEqual(calls.at(-2), [
    "stop",
    "rapi-bot.service",
    "rapi-worker.service",
  ]);
  assert.deepEqual(calls.at(-1), [
    "start",
    "rapi-bot.service",
    "rapi-worker.service",
    "rapi-public-gateway.service",
  ]);
});
