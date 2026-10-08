import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  releaseFileDigests,
  verifyRelease,
} from "../scripts/release-artifact.mjs";

async function release(gates: string[]): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "rapi-gates-")));
  await mkdir(join(path, "packages/db/migrations"), { recursive: true });
  await writeFile(
    join(path, "packages/db/migrations/0001_a.sql"),
    "SELECT 1;\n",
  );
  const sha = "a".repeat(40);
  await writeFile(
    join(path, "release-manifest.json"),
    JSON.stringify({
      sha,
      tree: sha,
      stagedPath: path,
      verifiedAt: new Date().toISOString(),
      gates,
      switched: false,
      files: await releaseFileDigests(path),
      migrations: ["0001_a.sql"],
    }),
  );
  return path;
}

test("a release needs either the full host gates or the CI-verified set", async () => {
  await verifyRelease(
    await release([
      "npm ci",
      "check",
      "web-proxy:test",
      "test:e2e",
      "restart:smoke",
      "restore:smoke",
      "audit:prod",
    ]),
  );
  await verifyRelease(
    await release(["npm ci", "build", "restore:smoke", "github-ci"]),
  );
  await assert.rejects(
    verifyRelease(await release(["npm ci", "build", "github-ci"])),
    /incomplete/,
  );
  await assert.rejects(
    verifyRelease(await release(["npm ci", "build", "restore:smoke"])),
    /incomplete/,
  );
});
