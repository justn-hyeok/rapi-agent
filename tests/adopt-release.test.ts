import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  lstat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adoptRelease, type LegacyDriver } from "../scripts/adopt-release.mjs";
import { releaseFileDigests } from "../scripts/release-artifact.mjs";

test("first deployment restores observed legacy runtime on failure and never starts its inactive worker", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rapi-adopt-")));
  try {
    const stage = join(root, "stage");
    await mkdir(join(stage, "packages/db/migrations"), { recursive: true });
    await writeFile(
      join(stage, "packages/db/migrations/0001_test.sql"),
      "SELECT 1;\n",
    );
    const sha = "a".repeat(40);
    await writeFile(
      join(stage, "release-manifest.json"),
      JSON.stringify({
        sha,
        tree: sha,
        stagedPath: stage,
        switched: false,
        gates: [
          "npm ci",
          "check",
          "web-proxy:test",
          "test:e2e",
          "restart:smoke",
          "restore:smoke",
          "audit:prod",
        ],
        migrations: ["0001_test.sql"],
        files: await releaseFileDigests(stage),
      }),
    );
    const current = join(root, "current");
    let fail = true;
    let legacy = true;
    const starts: string[][] = [];
    const driver: LegacyDriver = {
      async active() {
        return ["bot"];
      },
      async snapshot() {
        return { active: ["bot"], checkoutSha: "legacy-unsealed" };
      },
      async legacyReady() {
        assert.equal(legacy, true);
      },
      async wire() {
        legacy = false;
      },
      async restore() {
        legacy = true;
      },
      async stop() {},
      async start(names) {
        starts.push(names);
      },
      async ready(_names, expected) {
        assert.equal(expected, sha);
        if (fail) throw new Error("new process failed");
      },
    };
    const options = {
      currentPath: current,
      candidatePath: stage,
      expectedSha: sha,
      driver,
    };
    const failed = join(root, "failed.json");
    await assert.rejects(
      adoptRelease({ ...options, receiptPath: failed }),
      /legacy runtime restored/,
    );
    await assert.rejects(lstat(current), { code: "ENOENT" });
    const receipt = JSON.parse(await readFile(failed, "utf8")) as {
      predecessorEvidence: string;
      rollback: string;
    };
    assert.match(receipt.predecessorEvidence, /no sealed revision claim/);
    assert.equal(receipt.rollback, "legacy runtime restored");
    fail = false;
    assert.equal(
      (
        await adoptRelease({
          ...options,
          receiptPath: join(root, "success.json"),
        })
      ).status,
      "adopted",
    );
    assert.equal(await realpath(current), stage);
    assert.ok(
      starts.every((names) => names.length === 1 && names[0] === "bot"),
    );
    await assert.rejects(
      adoptRelease({ ...options, receiptPath: join(root, "duplicate.json") }),
      /absent current pointer/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
