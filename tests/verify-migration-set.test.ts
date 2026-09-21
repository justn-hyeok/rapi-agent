import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "verify-migration-set.mjs",
);

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface MigrationSetReport {
  expected: string[];
  applied: string[];
  missing: string[];
  unexpected: string[];
  ok: boolean;
}

function parseReport(value: string): MigrationSetReport {
  return JSON.parse(value) as MigrationSetReport;
}

function run(args: string[]): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function setup(
  t: TestContext,
  files: string[],
  applied: string[],
): { directory: string; appliedPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), "verify-migration-set-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "migrations");
  mkdirSync(directory);
  for (const name of files) {
    writeFileSync(path.join(directory, name), "-- migration\n");
  }
  const appliedPath = path.join(root, "applied.json");
  writeFileSync(appliedPath, JSON.stringify(applied));
  return { directory, appliedPath };
}

test("equal sets: exits 0 and reports ok with no diffs", (t) => {
  const { directory, appliedPath } = setup(
    t,
    ["001_init.sql", "002_add_users.sql", "notes.txt", "draft.sql"],
    ["002_add_users.sql", "001_init.sql"],
  );
  const result = run(["--directory", directory, "--applied", appliedPath]);
  assert.equal(result.status, 0, result.stderr);
  const report = parseReport(result.stdout);
  assert.deepEqual(report, {
    expected: ["001_init.sql", "002_add_users.sql"],
    applied: ["001_init.sql", "002_add_users.sql"],
    missing: [],
    unexpected: [],
    ok: true,
  });
});

test("missing migration: exits 1 and lists the missing file", (t) => {
  const { directory, appliedPath } = setup(
    t,
    ["001_init.sql", "002_add_users.sql"],
    ["001_init.sql"],
  );
  const result = run(["--directory", directory, "--applied", appliedPath]);
  assert.equal(result.status, 1);
  const report = parseReport(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ["002_add_users.sql"]);
  assert.deepEqual(report.unexpected, []);
});

test("unexpected applied entry: exits 1 and lists the extra file", (t) => {
  const { directory, appliedPath } = setup(
    t,
    ["001_init.sql"],
    ["001_init.sql", "003_extra.sql"],
  );
  const result = run(["--directory", directory, "--applied", appliedPath]);
  assert.equal(result.status, 1);
  const report = parseReport(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unexpected, ["003_extra.sql"]);
});

test("requires exactly --directory and --applied", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "verify-migration-set-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "applied.json");
  writeFileSync(file, "[]");

  assert.equal(run([]).status, 1);
  assert.equal(run(["--directory", root]).status, 1);
  assert.equal(run(["--applied", file]).status, 1);
  assert.equal(
    run(["--directory", root, "--applied", file, "--extra", "x"]).status,
    1,
  );
});
