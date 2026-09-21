import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildQuarantineManifest } from "../scripts/fixture-quarantine-manifest.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL("../scripts/fixture-quarantine-manifest.mjs", import.meta.url),
);

interface QuarantineOutput {
  deactivateSubscriptionIds: string[];
  retainedFixtureIds: string[];
}

function parseQuarantineOutput(value: string): QuarantineOutput {
  return JSON.parse(value) as QuarantineOutput;
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
  const dir = await mkdtemp(join(tmpdir(), "fixture-quarantine-manifest-"));
  const path = join(dir, "input.json");
  await writeFile(path, contents);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildQuarantineManifest", () => {
  it("selects fixture subscription ids for deactivation", () => {
    const manifest = buildQuarantineManifest([
      { id: "sub-1", kind: "subscription", locator: "example/rapi" },
      { id: "sub-2", kind: "subscription", ownerId: "owner-1" },
    ]);
    assert.deepEqual(manifest.deactivateSubscriptionIds, ["sub-1", "sub-2"]);
    assert.deepEqual(manifest.retainedFixtureIds, ["sub-1", "sub-2"]);
  });

  it("retains fixture non-subscription records without deactivating them", () => {
    const manifest = buildQuarantineManifest([
      {
        id: "src-1",
        kind: "source",
        locator: "https://example.com/feed.xml",
      },
      { id: "sess-1", kind: "session", locator: "approved-browser-session" },
    ]);
    assert.deepEqual(manifest.deactivateSubscriptionIds, []);
    assert.deepEqual(manifest.retainedFixtureIds, ["sess-1", "src-1"]);
  });

  it("ignores live records entirely", () => {
    const manifest = buildQuarantineManifest([
      {
        id: "live-sub",
        kind: "subscription",
        locator: "https://real.example.org/feed",
      },
      { id: "live-src", kind: "source", ownerId: "owner-2" },
    ]);
    assert.deepEqual(manifest.deactivateSubscriptionIds, []);
    assert.deepEqual(manifest.retainedFixtureIds, []);
  });

  it("returns sorted unique ids", () => {
    const manifest = buildQuarantineManifest([
      { id: "sub-b", kind: "subscription", locator: "example/rapi" },
      { id: "sub-a", kind: "subscription", locator: "example/rapi" },
      { id: "sub-b", kind: "subscription", locator: "example/rapi" },
      { id: "src-z", kind: "source", locator: "example/rapi" },
    ]);
    assert.deepEqual(manifest.deactivateSubscriptionIds, ["sub-a", "sub-b"]);
    assert.deepEqual(manifest.retainedFixtureIds, ["src-z", "sub-a", "sub-b"]);
  });

  it("throws on an ambiguous record instead of producing a manifest", () => {
    assert.throws(
      () =>
        buildQuarantineManifest([
          { id: "sub-1", kind: "subscription", locator: "example/rapi" },
          {
            id: "amb-1",
            kind: "subscription",
            locator: "example/rapi",
            ownerId: "owner-9",
          },
        ]),
      /ambiguous/,
    );
  });

  it("throws on non-object records", () => {
    assert.throws(() => buildQuarantineManifest([null]), /not a plain object/);
    assert.throws(() => buildQuarantineManifest([42]), /not a plain object/);
    assert.throws(
      () => buildQuarantineManifest([["example/rapi"]]),
      /not a plain object/,
    );
  });
});

describe("fixture-quarantine-manifest CLI", () => {
  it("prints a JSON manifest for valid input", async () => {
    const input = JSON.stringify([
      { id: "sub-1", kind: "subscription", locator: "example/rapi" },
      { id: "src-1", kind: "source", ownerId: "owner-1" },
      { id: "live-1", kind: "subscription", ownerId: "owner-2" },
    ]);
    await withInputFile(input, async (path) => {
      const { code, stdout, stderr } = await runCli(["--input", path]);
      assert.equal(code, 0, stderr);
      assert.deepEqual(parseQuarantineOutput(stdout), {
        deactivateSubscriptionIds: ["sub-1"],
        retainedFixtureIds: ["src-1", "sub-1"],
      });
    });
  });

  it("fails on ambiguous input without printing a manifest", async () => {
    const input = JSON.stringify([
      {
        id: "amb-1",
        kind: "subscription",
        locator: "example/rapi",
        recipientId: "person@corp.example",
      },
    ]);
    await withInputFile(input, async (path) => {
      const { code, stdout, stderr } = await runCli(["--input", path]);
      assert.notEqual(code, 0);
      assert.equal(stdout, "");
      assert.match(stderr, /ambiguous/);
    });
  });

  it("fails on malformed JSON, non-array input, and non-object records", async () => {
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
