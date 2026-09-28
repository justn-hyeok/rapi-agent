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
