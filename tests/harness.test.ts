import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { z } from "zod";
import { CodexExecutor } from "../apps/chat/src/executor.js";
import {
  codexHarness,
  ownerHarnessDirective,
  parseHarnessDirective,
  selectHarness,
  senpiHarness,
  type Harness,
  type HarnessInput,
} from "../apps/chat/src/harness.js";

const input: HarnessInput = {
  prompt: "do it",
  execute: true,
  repository: "/repo",
  outputPath: "/work/run-abc123/answer.txt",
};

test("codex argv stays unchanged", () => {
  const harness = codexHarness("default-model");
  const execute = harness.build({ ...input, model: "gpt-x" });
  assert.equal(execute.command, "/usr/local/bin/codex");
  assert.deepEqual(execute.args, [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--model",
    "gpt-x",
    "--dangerously-bypass-approvals-and-sandbox",
    "--color",
    "never",
    "--output-last-message",
    "/work/run-abc123/answer.txt",
    "-C",
    "/repo",
    "-",
  ]);
  assert.equal(execute.stdin, "do it");
  assert.equal(execute.reportFile, "/work/run-abc123/answer.txt");
  const readOnly = harness.build({ ...input, execute: false });
  assert.deepEqual(readOnly.args.slice(3, 7), [
    "--model",
    "default-model",
    "--sandbox",
    "read-only",
  ]);
});

test("senpi runs in print mode with telemetry off, no project trust and filtered env", () => {
  process.env.TEST_SENPI_API_KEY = "secret";
  process.env.DATABASE_URL = "postgres://secret";
  try {
    const built = senpiHarness("/bin/senpi", "/var/lib/x").build({
      ...input,
      model: "anthropic/claude-x",
    });
    assert.equal(built.command, "/bin/senpi");
    assert.deepEqual(built.args, [
      "-p",
      "--no-session",
      "--no-approve",
      "--model",
      "anthropic/claude-x",
    ]);
    assert.equal(built.cwd, "/repo");
    assert.equal(built.stdin, "do it");
    assert.equal(built.env.PI_TELEMETRY, "0");
    assert.equal(built.env.PI_SKIP_VERSION_CHECK, "1");
    assert.equal(built.env.PI_CODING_AGENT_DIR, "/var/lib/x/agent");
    assert.equal(built.env.TEST_SENPI_API_KEY, undefined);
    assert.equal(built.env.DATABASE_URL, undefined);
    assert.ok(!senpiHarness().build(input).args.includes("--model"));
  } finally {
    delete process.env.TEST_SENPI_API_KEY;
    delete process.env.DATABASE_URL;
  }
});

test("senpi refuses read-only work", () => {
  assert.throws(() => senpiHarness().build({ ...input, execute: false }));
});

test("read-only runs never select senpi", () => {
  for (const requested of [undefined, "senpi" as const])
    for (const fallback of ["codex", "senpi"] as const) {
      const selection = selectHarness({
        execute: false,
        ...(requested ? { requested } : {}),
        fallback,
        senpiReady: true,
      });
      assert.equal(selection.id, "codex");
    }
  assert.ok(
    selectHarness({
      execute: false,
      requested: "senpi",
      fallback: "codex",
      senpiReady: true,
    }).notice,
  );
});

test("senpi that is not ready falls back to codex with a notice", () => {
  const selection = selectHarness({
    execute: true,
    requested: "senpi",
    fallback: "codex",
    senpiReady: false,
  });
  assert.equal(selection.id, "codex");
  assert.match(selection.notice ?? "", /senpi/);
  assert.equal(
    selectHarness({
      execute: true,
      requested: "senpi",
      fallback: "codex",
      senpiReady: true,
    }).id,
    "senpi",
  );
  assert.equal(
    selectHarness({ execute: true, fallback: "codex", senpiReady: true }).id,
    "codex",
  );
});

test("the harness override is parsed from the owner's prefix", () => {
  assert.deepEqual(parseHarnessDirective("센파이로 테스트 고쳐줘"), {
    harness: "senpi",
    task: "테스트 고쳐줘",
  });
  assert.deepEqual(parseHarnessDirective("senpi: fix tests"), {
    harness: "senpi",
    task: "fix tests",
  });
  assert.deepEqual(parseHarnessDirective("테스트 고쳐줘"), {
    task: "테스트 고쳐줘",
  });
});

test("only the owner can override the harness", () => {
  assert.equal(
    ownerHarnessDirective("senpi: fix tests", "superadmin").harness,
    "senpi",
  );
  for (const level of ["admin", "user"])
    assert.deepEqual(ownerHarnessDirective("senpi: fix tests", level), {
      task: "senpi: fix tests",
    });
});

function recording(
  id: "codex" | "senpi",
  ready: boolean,
  log: string[],
): Harness {
  return {
    id,
    build: (built) => {
      log.push(`${id}:${built.execute}`);
      return {
        command: "/bin/sh",
        args: ["-c", "printf ok"],
        env: {},
      };
    },
    readiness: async () => ({ binary: ready, configured: ready }),
  };
}

test("executor routes execution to senpi only when asked and ready", async () => {
  const run = async (ready: boolean, execute: boolean, harness?: "senpi") => {
    const log: string[] = [];
    const executor = new CodexExecutor("/repo", "/tmp", {
      harnesses: {
        codex: recording("codex", true, log),
        senpi: recording("senpi", ready, log),
      },
    });
    const result = await executor.run({
      prompt: "p",
      execute,
      ...(harness ? { harness } : {}),
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
    return { log, result };
  };
  assert.deepEqual((await run(true, true, "senpi")).log, ["senpi:true"]);
  assert.deepEqual((await run(true, false, "senpi")).log, ["codex:false"]);
  const fallback = await run(false, true, "senpi");
  assert.deepEqual(fallback.log, ["codex:true"]);
  assert.match(fallback.result.notice ?? "", /Codex/);
  assert.deepEqual((await run(true, true)).log, ["codex:true"]);
});

test("harness-versions.json pins senpi to a checksummed release asset", async () => {
  const parsed = z
    .object({
      senpi: z.object({
        version: z.string().regex(/^\d{4}\.\d+\.\d+(-\d+)?$/),
        asset: z.string().regex(/^pi-linux-x64\.tar\.gz$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    })
    .strict()
    .parse(JSON.parse(await readFile("ops/harness-versions.json", "utf8")));
  assert.equal(parsed.senpi.version, "2026.10.21-3");
});
