import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { classifyFixtureRecord } from "../scripts/fixture-inventory.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL("../scripts/fixture-inventory.mjs", import.meta.url),
);

interface InventoryOutput {
  summary: {
    fixture: number;
    live: number;
    ambiguous: number;
    total: number;
  };
  records: Array<{ index: number; classification: string }>;
}

function parseInventoryOutput(value: string): InventoryOutput {
  return JSON.parse(value) as InventoryOutput;
}

async function runCli(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

async function withInputFile(
  contents: string,
  fn: (path: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "fixture-inventory-"));
  const path = join(dir, "input.json");
  await writeFile(path, contents);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("classifyFixtureRecord", () => {
  it("classifies each fixture locator as fixture", () => {
    for (const locator of [
      "example/rapi",
      "https://example.com/feed.xml",
      "https://invalid.example/feed.xml",
      "approved-browser-session",
    ]) {
      assert.equal(classifyFixtureRecord({ locator }), "fixture", locator);
    }
  });

  it("classifies fixture owner and recipient identities as fixture", () => {
    assert.equal(classifyFixtureRecord({ ownerId: "owner-1" }), "fixture");
    assert.equal(
      classifyFixtureRecord({ recipientId: "test@example.com" }),
      "fixture",
    );
    assert.equal(
      classifyFixtureRecord({
        locator: "example/rapi",
        ownerId: "owner-1",
        recipientId: "test@example.com",
      }),
      "fixture",
    );
  });

  it("classifies records without fixture evidence as live", () => {
    assert.equal(classifyFixtureRecord({}), "live");
    assert.equal(
      classifyFixtureRecord({ ownerId: "owner-2", recipientId: "a@b.co" }),
      "live",
    );
    assert.equal(
      classifyFixtureRecord({ locator: "https://real.example.org/feed" }),
      "live",
    );
  });

  it("classifies fixture evidence plus an unrelated user identity as ambiguous", () => {
    assert.equal(
      classifyFixtureRecord({ locator: "example/rapi", ownerId: "owner-9" }),
      "ambiguous",
    );
    assert.equal(
      classifyFixtureRecord({
        ownerId: "owner-1",
        recipientId: "person@corp.example",
      }),
      "ambiguous",
    );
  });

  it("rejects non-object records", () => {
    assert.throws(() => classifyFixtureRecord(null), TypeError);
    assert.throws(() => classifyFixtureRecord([1, 2]), TypeError);
    assert.throws(() => classifyFixtureRecord("example/rapi"), TypeError);
  });
});

describe("fixture-inventory CLI", () => {
  it("prints summary counts and per-record classifications", async () => {
    const input = JSON.stringify([
      { locator: "example/rapi" },
      { ownerId: "owner-2" },
      { locator: "approved-browser-session", recipientId: "x@y.z" },
    ]);
    await withInputFile(input, async (path) => {
      const { code, stdout, stderr } = await runCli(["--input", path]);
      assert.equal(code, 0, stderr);
      const parsed = parseInventoryOutput(stdout);
      assert.deepEqual(parsed.summary, {
        fixture: 1,
        live: 1,
        ambiguous: 1,
        total: 3,
      });
      assert.deepEqual(parsed.records, [
        { index: 0, classification: "fixture" },
        { index: 1, classification: "live" },
        { index: 2, classification: "ambiguous" },
      ]);
    });
  });

  it("fails on malformed JSON and non-array input", async () => {
    await withInputFile("{not json", async (path) => {
      const { code, stderr } = await runCli(["--input", path]);
      assert.notEqual(code, 0);
      assert.match(stderr, /cannot read\/parse/);
    });
    await withInputFile('{"records": []}', async (path) => {
      const { code, stderr } = await runCli(["--input", path]);
      assert.notEqual(code, 0);
      assert.match(stderr, /JSON array/);
    });
    await withInputFile("[1, 2, 3]", async (path) => {
      const { code, stderr } = await runCli(["--input", path]);
      assert.notEqual(code, 0);
      assert.match(stderr, /not a plain object/);
    });
  });

  it("fails without exactly one --input argument", async () => {
    for (const args of [
      [],
      ["--input"],
      ["input.json"],
      ["--input", "a.json", "--input", "b.json"],
    ]) {
      const { code, stderr } = await runCli(args);
      assert.notEqual(code, 0, JSON.stringify(args));
      assert.match(stderr, /Usage:/);
    }
  });
});
