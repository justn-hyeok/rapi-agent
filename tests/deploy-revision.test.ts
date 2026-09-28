import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/deploy-revision.sh", import.meta.url),
);

test("release staging validates a clean SHA and keeps production DB inputs away from smoke gates", () => {
  const root = mkdtempSync(join(tmpdir(), "rapi-release-test-"));
  try {
    const repo = join(root, "repo");
    const stageRoot = join(root, "stage");
    const bin = join(root, "bin");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    mkdirSync(stageRoot);
    mkdirSync(bin);
    copyFileSync(script, join(repo, "scripts/deploy-revision.sh"));
    copyFileSync(
      fileURLToPath(
        new URL("../scripts/release-artifact.mjs", import.meta.url),
      ),
      join(repo, "scripts/release-artifact.mjs"),
    );
    mkdirSync(join(repo, "packages/db/migrations"), { recursive: true });
    writeFileSync(
      join(repo, "packages/db/migrations/0001_test.sql"),
      "SELECT 1;\n",
    );
    writeFileSync(
      join(repo, "package.json"),
      '{"name":"release-fixture","version":"1.0.0"}\n',
    );
    const calls = join(root, "npm-calls.txt");
    writeFileSync(
      join(bin, "npm"),
      '#!/bin/sh\n[ -z "${DATABASE_URL:-}" ] || exit 83\n[ -z "${BACKUP_FILE:-}" ] || exit 84\n[ -z "${MIGRATION_DATABASE_URL:-}" ] || exit 85\n[ "$RAPI_ENV" = test ] || exit 86\nprintf "%s\\n" "$*" >> "$RAPI_FAKE_NPM_LOG"\n',
      { mode: 0o755 },
    );
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DATABASE_URL: "postgresql://production.invalid/db",
      MIGRATION_DATABASE_URL: "postgresql://production.invalid/migration_db",
      RAPI_ENV: "production",
      BACKUP_FILE: "/production.dump",
      RAPI_FAKE_NPM_LOG: calls,
      RAPI_RELEASE_SHA: sha,
      RAPI_RELEASE_ROOT: stageRoot,
    };
    const run = spawnSync("bash", ["scripts/deploy-revision.sh"], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const stages = readdirSync(stageRoot);
    assert.equal(stages.length, 1);
    const manifest: unknown = JSON.parse(
      readFileSync(
        join(stageRoot, stages[0]!, "release-manifest.json"),
        "utf8",
      ),
    );
    assert.ok(manifest && typeof manifest === "object");
    assert.ok("sha" in manifest && "switched" in manifest);
    assert.equal(manifest.sha, sha);
    assert.equal(manifest.switched, false);
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
      "ci",
      "run check",
      "run web-proxy:test",
      "run test:e2e",
      "run restart:smoke",
      "run restore:smoke",
      "run audit:prod",
    ]);

    writeFileSync(join(repo, "untracked.txt"), "dirty\n");
    const dirtyRun = spawnSync("bash", ["scripts/deploy-revision.sh"], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    assert.equal(dirtyRun.status, 2);
    assert.match(dirtyRun.stderr, /diff or untracked files/);
    assert.equal(readdirSync(stageRoot).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
