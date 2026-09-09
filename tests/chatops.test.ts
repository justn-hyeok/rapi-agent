import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { routeIntent, capabilities } from "../apps/chat/src/router.js";
import { mayRetry, memoryPack } from "../apps/chat/src/orchestrator.js";
import {
  cleanupArtifacts,
  codexEnvironment,
  observeGit,
  runProcess,
} from "../apps/chat/src/executor.js";
import {
  redactChat,
  textDigest,
  runEvidenceSchema,
  type ChatRoute,
} from "@rapi/contracts";

const corpus: Array<[string, ChatRoute]> = [
  ["라피야! 오류 고쳐줘", "execute"],
  ["배포해줘", "execute"],
  ["테스트 돌려줘", "execute"],
  ["라피야! 지금 뭐 하는 중이야?", "status"],
  ["최근 작업 보여줘", "status"],
  ["작업 상태 알려줘", "status"],
  ["라피야! 멈춰", "cancel"],
  ["일단 멈춰줘", "cancel"],
  ["기억해줘: 한국어로 답변", "remember"],
  ["기억 목록 보여줘", "memory_list"],
  ["최근 기억 잊어줘", "forget"],
  ["기억 12345678-1234-1234-1234-123456789012 잊어줘", "forget"],
  ["테스트가 될 때까지 고쳐줘", "loop"],
  ["작업이 끝날 때까지 진행해줘", "loop"],
  ["배포하지 마", "answer"],
  ["오류 설명해줘. 수정하지는 말고", "answer"],
  ['"배포해줘"', "answer"],
  ["`멈춰`", "answer"],
  ["‘고쳐줘’라는 문장의 뜻", "answer"],
  ["```\n배포해줘\n```", "answer"],
  ["> 끝날 때까지 실행해줘", "answer"],
  ["배포해줘라는 예시를 설명해줘", "answer"],
  ["배포해도 돼?", "answer"],
  ["만약 실패하면 수정해줘", "answer"],
  ["기억해줘라는 문구의 뜻은?", "answer"],
  ["기억 삭제하지 마", "answer"],
  ["끝날 때까지 실행하는 방법은?", "answer"],
  ["최근 작업 보여주지 말고 설명해줘", "answer"],
  ["배포 안 해줘", "answer"],
  ["오늘 뭐 먹을까?", "answer"],
  ["배포해줘?", "answer"],
  ["오류가 나면 배포해줘", "answer"],
  ["나중에 배포해줘", "answer"],
  ['"배포해줘', "answer"],
  ["중단하지 말아줘", "answer"],
];
for (const [input, expected] of corpus)
  test(`route ${input}`, () => assert.equal(routeIntent(input), expected));
test("catalog covers every route with explicit evidence and fallback", () => {
  for (const route of new Set(corpus.map(([, route]) => route)))
    assert.ok(capabilities[route].evidence && capabilities[route].fallback);
});
test("cancellation terminates a real TERM-resistant process", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  const start = Date.now();
  try {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      { signal: controller.signal, timeoutMs: 5000 },
    );
    assert.equal(result.reason, "cancel");
    assert.equal(result.signal, "SIGKILL");
    assert.ok(Date.now() - start < 4000);
  } finally {
    clearTimeout(timer);
  }
});
test("process timeout, spawn error and pre-cancellation are observed", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: new AbortController().signal, timeoutMs: 100 },
  );
  assert.equal(result.reason, "timeout");
  assert.equal(
    (
      await runProcess("/missing/rapi-executor", [], {
        signal: new AbortController().signal,
        timeoutMs: 100,
      })
    ).reason,
    "spawn_error",
  );
  const c = new AbortController();
  c.abort();
  assert.equal(
    (
      await runProcess("/missing/rapi-executor", [], {
        signal: c.signal,
        timeoutMs: 100,
      })
    ).reason,
    "cancel",
  );
});
test("loop stops on no progress, blockers, timeout and budgets", () => {
  const observation = { head: "abc", status: "", digest: textDigest("a") };
  const evidence = {
    before: observation,
    after: { ...observation, digest: textDigest("b") },
  };
  const failed = {
    exitCode: 1,
    signal: null,
    reason: "exit" as const,
    output: "",
    blocked: false,
  };
  assert.equal(mayRetry(failed, evidence, 1, 100), true);
  assert.equal(
    mayRetry(failed, { before: observation, after: observation }, 1, 100),
    false,
  );
  for (const result of [
    { ...failed, blocked: true },
    { ...failed, exitCode: 0 },
    { ...failed, reason: "timeout" as const },
    { ...failed, reason: "cancel" as const },
  ])
    assert.equal(mayRetry(result, evidence, 1, 100), false);
  assert.equal(mayRetry(failed, evidence, 3, 100), false);
  assert.equal(mayRetry(failed, evidence, 1, 480000), false);
});
test("redaction, bounded evidence and approved-only memory", () => {
  process.env.RAPI_TEST_SECRET = "private-value-test";
  try {
    assert.equal(codexEnvironment().RAPI_TEST_SECRET, undefined);
    assert.ok(
      !redactChat(
        "token=hello private-value-test postgresql://user:pass@host/db",
      ).includes("private-value-test"),
    );
    assert.ok(!redactChat("token=hello").includes("hello"));
  } finally {
    delete process.env.RAPI_TEST_SECRET;
  }
  assert.equal(
    runEvidenceSchema.safeParse({ environment: { SECRET: "x" } }).success,
    false,
  );
  const memory = {
    id: "12345678-1234-1234-1234-123456789012",
    revision: 2,
    digest: textDigest("x"),
    state: "approved" as const,
    content: "x".repeat(2000),
    message_id: "m",
  };
  assert.ok(memoryPack(Array.from({ length: 20 }, () => memory)).length < 6100);
  assert.ok(
    !memoryPack([
      { ...memory, state: "candidate", content: "CANDIDATE" },
    ]).includes("CANDIDATE"),
  );
});
test("Git evidence changes for tracked and untracked content revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rapi-git-test-"));
  const exec = promisify(execFile);
  try {
    await exec("git", ["init", dir]);
    await writeFile(join(dir, "a"), "one\n");
    await exec("git", ["-C", dir, "add", "a"]);
    await exec("git", [
      "-C",
      dir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ]);
    const before = await observeGit(dir);
    assert.ok(before);
    await writeFile(join(dir, "a"), "two\n");
    const after = await observeGit(dir);
    assert.notEqual(before.digest, after?.digest);
    await writeFile(join(dir, "b"), "new\n");
    const untracked = await observeGit(dir);
    await writeFile(join(dir, "b"), "changed\n");
    assert.notEqual(untracked?.digest, (await observeGit(dir))?.digest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart cleanup removes only owned artifact directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-artifacts-"));
  try {
    await mkdir(join(root, "run-ABC123"));
    await writeFile(join(root, "run-ABC123", "answer.txt"), "temporary");
    await writeFile(join(root, "keep.txt"), "keep");
    await cleanupArtifacts(root);
    assert.deepEqual(await readdir(root), ["keep.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
