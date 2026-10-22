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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  switchRelease,
  type ServiceDriver,
} from "../scripts/switch-release.mjs";
import { releaseFileDigests } from "../scripts/release-artifact.mjs";

test("isolated service switch verifies boot revision, rolls back failure and preserves an inactive worker", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rapi-switch-")));
  let child: ChildProcess | undefined;
  let port = 0;
  try {
    async function stage(
      name: string,
      sha: string,
      ready: boolean,
    ): Promise<string> {
      const path = join(root, name);
      await mkdir(join(path, "packages/db/migrations"), { recursive: true });
      await writeFile(
        join(path, "packages/db/migrations/0001_test.sql"),
        "SELECT 1;\n",
      );
      await writeFile(
        join(path, "service.mjs"),
        `import {createServer} from 'node:http'; import {readFileSync} from 'node:fs'; const revision = JSON.parse(readFileSync('release-manifest.json')).sha; const server = createServer((req,res)=>{res.writeHead(${ready ? 200 : 503});res.end(JSON.stringify({ready:${ready},revision}));}); server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n')); process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`,
      );
      await writeFile(
        join(path, "release-manifest.json"),
        JSON.stringify({
          sha,
          tree: sha,
          stagedPath: path,
          verifiedAt: new Date().toISOString(),
          gates: [
            "npm ci",
            "check",
            "web-proxy:test",
            "test:e2e",
            "restart:smoke",
            "restore:smoke",
            "audit:prod",
          ],
          switched: false,
          files: await releaseFileDigests(path),
          migrations: ["0001_test.sql"],
        }),
      );
      return path;
    }
    const oldSha = "1".repeat(40);
    const badSha = "2".repeat(40);
    const goodSha = "3".repeat(40);
    const previous = await stage("previous", oldSha, true);
    const bad = await stage("bad", badSha, false);
    const good = await stage("good", goodSha, true);
    const current = join(root, "current");
    await symlink(previous, current);
    const started: string[][] = [];
    const driver: ServiceDriver = {
      async active() {
        return ["bot"];
      },
      async stop() {
        if (!child) return;
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
        child = undefined;
      },
      async start(services) {
        started.push(services);
        child = spawn(process.execPath, ["service.mjs"], {
          cwd: current,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const [output] = (await once(child.stdout!, "data")) as [Buffer];
        port = Number(output.toString().trim());
        assert.ok(port > 0);
      },
      async ready(_services, sha) {
        const response = await fetch(`http://127.0.0.1:${port}/ready`, {
          signal: AbortSignal.timeout(2000),
        });
        const body = (await response.json()) as {
          ready: boolean;
          revision: string;
        };
        if (!response.ok || !body.ready || body.revision !== sha)
          throw new Error("readiness mismatch");
      },
    };
    await driver.start(["bot"]);
    const options = {
      currentPath: current,
      services: ["bot", "worker"],
      driver,
    };
    const failedReceipt = join(root, "failed-receipt.json");
    await assert.rejects(
      switchRelease({
        ...options,
        candidatePath: bad,
        expectedSha: badSha,
        receiptPath: failedReceipt,
      }),
      /rollback verified/,
    );
    assert.equal(await realpath(current), previous);
    await driver.ready(["bot"], oldSha);
    const receipt = JSON.parse(await readFile(failedReceipt, "utf8")) as {
      rollback: string;
    };
    assert.equal(receipt.rollback, "verified");
    const switched = await switchRelease({
      ...options,
      candidatePath: good,
      expectedSha: goodSha,
      receiptPath: join(root, "success-receipt.json"),
    });
    assert.equal(switched.status, "switched");
    await driver.ready(["bot"], goodSha);
    assert.ok(
      started.every(
        (services) => services.length === 1 && services[0] === "bot",
      ),
    );
    await writeFile(join(bad, "service.mjs"), "tampered");
    await assert.rejects(
      switchRelease({
        ...options,
        candidatePath: bad,
        expectedSha: badSha,
        receiptPath: join(root, "tamper-receipt.json"),
      }),
      /digest mismatch/,
    );
    await driver.ready(["bot"], goodSha);
    await driver.stop(["bot"]);
  } finally {
    if (child) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy readiness ignores only external source outages", async () => {
  const { deployReady } = await import("../scripts/switch-release.mjs");
  const sha = "a".repeat(40);
  const component = (name: string, status = "failed", required = true) => ({
    name,
    status,
    required,
  });
  assert.equal(
    deployReady("worker", 200, { ready: true, revision: sha }, sha),
    true,
  );
  assert.equal(
    deployReady(
      "worker",
      503,
      {
        ready: false,
        revision: sha,
        components: [component("database", "ok"), component("sources")],
      },
      sha,
    ),
    true,
  );
  assert.equal(
    deployReady(
      "worker",
      503,
      {
        ready: false,
        revision: sha,
        components: [component("sources"), component("database")],
      },
      sha,
    ),
    false,
  );
  assert.equal(
    deployReady(
      "worker",
      503,
      { ready: false, revision: sha, components: [component("sources")] },
      "b".repeat(40),
    ),
    false,
  );
  assert.equal(
    deployReady(
      "worker",
      503,
      { ready: false, revision: sha, components: [] },
      sha,
    ),
    false,
  );
  assert.equal(
    deployReady("monitor", 200, { status: "ok", revision: sha }, sha),
    true,
  );
  assert.equal(
    deployReady(
      "monitor",
      200,
      { status: "ok", revision: "b".repeat(40) },
      sha,
    ),
    false,
  );
});

test("a candidate may not fail more sources than the running release", async () => {
  const { systemdDriver, deployReady } = await import(
    "../scripts/switch-release.mjs"
  );
  const { createServer } = await import("node:http");
  const oldSha = "a".repeat(40);
  const newSha = "b".repeat(40);
  const body = (revision: string, failing: number) => ({
    ready: failing === 0,
    revision,
    components: [
      { name: "database", status: "ok", required: true },
      {
        name: "sources",
        status: failing ? "failed" : "ok",
        required: true,
        details: { configured: 34, failing },
      },
    ],
  });
  assert.equal(deployReady("worker", 503, body(newSha, 1), newSha, 1), true);
  assert.equal(deployReady("worker", 503, body(newSha, 34), newSha, 1), false);
  let current = body(oldSha, 1);
  const server = createServer((_req, res) => {
    res.writeHead(current.ready ? 200 : 503);
    res.end(JSON.stringify(current));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as { port: number }).port;
  try {
    const driver = systemdDriver({ worker: port }, 2, async () => ({
      stdout: "",
    }));
    await driver.ready(["worker"], oldSha);
    current = body(newSha, 1);
    await driver.ready(["worker"], newSha);
    current = body(newSha, 34);
    await assert.rejects(driver.ready(["worker"], newSha), /does not match/);
  } finally {
    server.close();
  }
});
