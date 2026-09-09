import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PostgresStore, ChatOpsStore } from "@rapi/db";
import { textDigest, type ChatScope, type RunEvidence } from "@rapi/contracts";
import { ChatOrchestrator } from "../../apps/chat/src/orchestrator.js";
import {
  runProcess,
  type Executor,
  type ExecuteInput,
} from "../../apps/chat/src/executor.js";

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== "/rapi_test")
  throw new Error("ChatOps E2E requires rapi_test");
const scope = (): ChatScope => ({
  guild: randomUUID(),
  channel: randomUUID(),
  owner: randomUUID(),
});

test("persistent transitions, append-only evidence, recovery and revision binding", async () => {
  const db = new PostgresStore(url);
  const store = new ChatOpsStore(db);
  const s = scope();
  try {
    const run = await store.prepare(s, randomUUID(), "execute", "수정해줘");
    assert.ok(run);
    assert.equal(
      await store.prepare(s, run.message_id, "execute", "수정해줘"),
      undefined,
    );
    await assert.rejects(store.transition(run.id, "prepared", "verified"));
    await store.transition(run.id, "prepared", "accepted");
    await store.transition(run.id, "accepted", "running");
    const after = {
      head: "abc",
      status: " M a",
      digest: textDigest("revision"),
    };
    const verification = {
      command: "git diff --check" as const,
      exitCode: 0,
      revision: after.digest,
      taskDigest: run.task_digest,
    };
    await assert.rejects(
      store.transition(run.id, "running", "reported_done", {
        after,
        verification: { ...verification, taskDigest: textDigest("other task") },
      }),
    );
    await assert.rejects(
      store.transition(run.id, "running", "reported_done", {
        after,
        verification: {
          ...verification,
          revision: textDigest("other revision"),
        },
      }),
    );
    const evidence: RunEvidence = {
      attempt: 1,
      exitCode: 0,
      after,
      verification,
    };
    await store.transition(run.id, "running", "reported_done", evidence);
    await assert.rejects(
      store.transition(run.id, "reported_done", "verified", {
        ...evidence,
        after: { ...after, digest: textDigest("new") },
      }),
    );
    await store.transition(run.id, "reported_done", "verified", evidence);
    await assert.rejects(store.transition(run.id, "verified", "running"));
    await assert.rejects(
      db.pool.query(
        "UPDATE chatops_events SET phase='verified' WHERE run_id=$1",
        [run.id],
      ),
    );
    await assert.rejects(
      db.pool.query("DELETE FROM chatops_events WHERE run_id=$1", [run.id]),
    );
    await assert.rejects(
      db.pool.query("UPDATE chatops_runs SET task_digest=$2 WHERE id=$1", [
        run.id,
        textDigest("mutated"),
      ]),
    );
    for (const phase of [
      "prepared",
      "accepted",
      "running",
      "cancel_requested",
    ] as const) {
      const abandoned = await store.prepare(
        s,
        randomUUID(),
        "execute",
        "고쳐줘",
      );
      assert.ok(abandoned);
      if (phase !== "prepared")
        await store.transition(abandoned.id, "prepared", "accepted");
      if (phase === "running" || phase === "cancel_requested")
        await store.transition(abandoned.id, "accepted", "running");
      if (phase === "cancel_requested")
        await store.transition(abandoned.id, "running", "cancel_requested");
      await store.recover();
      assert.equal((await store.get(abandoned.id)).phase, "interrupted");
      await assert.rejects(
        store.transition(abandoned.id, "interrupted", "running"),
      );
    }
    const active = await store.prepare(s, randomUUID(), "execute", "고쳐줘");
    assert.ok(active);
    await store.transition(active.id, "prepared", "accepted");
    await store.transition(active.id, "accepted", "running");
    for (let i = 0; i < 6; i++)
      await store.prepare(s, randomUUID(), "execute", "고쳐줘");
    assert.equal((await store.recent(s))[0]?.id, active.id);
    await store.recover();
    assert.equal((await store.get(run.id)).phase, "verified");
    const events = await db.pool.query<{ phase: string }>(
      "SELECT phase FROM chatops_events WHERE run_id=$1 ORDER BY seq",
      [run.id],
    );
    assert.deepEqual(
      events.rows.map((e) => e.phase),
      ["prepared", "accepted", "running", "reported_done", "verified"],
    );
  } finally {
    await db.close();
  }
});
test("memory lifecycle, scopes, provenance and stale revision rejection", async () => {
  const db = new PostgresStore(url);
  const store = new ChatOpsStore(db);
  const s = scope();
  try {
    const m = await store.remember(
      s,
      randomUUID(),
      "기본 언어는 한국어. token=secret-example",
    );
    assert.equal(m.revision, 2);
    assert.equal(m.state, "approved");
    assert.ok(!m.content.includes("secret-example"));
    assert.equal(m.digest, textDigest(m.content));
    assert.equal((await store.memories(scope())).length, 0);
    await assert.rejects(store.changeMemory(s, m.id, 1, m.digest, "forgotten"));
    await assert.rejects(
      store.changeMemory(s, m.id, m.revision, textDigest("wrong"), "forgotten"),
    );
    await assert.rejects(
      store.changeMemory(
        { ...s, owner: "different" },
        m.id,
        m.revision,
        m.digest,
        "forgotten",
      ),
    );
    const forgotten = await store.changeMemory(
      s,
      m.id,
      m.revision,
      m.digest,
      "forgotten",
    );
    assert.equal(forgotten.revision, 3);
    assert.equal((await store.memories(s)).length, 0);
    await assert.rejects(
      store.changeMemory(s, m.id, 3, m.digest, "superseded"),
    );
    const replacement = await store.remember(s, randomUUID(), "새 선호");
    await store.changeMemory(
      s,
      replacement.id,
      replacement.revision,
      replacement.digest,
      "superseded",
    );
    const history = await db.pool.query<{ state: string }>(
      "SELECT state FROM chatops_memory_events WHERE memory_id=$1 ORDER BY seq",
      [m.id],
    );
    assert.deepEqual(
      history.rows.map((row) => row.state),
      ["candidate", "approved", "forgotten"],
    );
    await assert.rejects(
      db.pool.query("DELETE FROM chatops_memory_events WHERE memory_id=$1", [
        m.id,
      ]),
    );
  } finally {
    await db.close();
  }
});
test("Discord duplicate admission, live status and actual cancellation bypass queue", async () => {
  const db = new PostgresStore(url);
  const store = new ChatOpsStore(db);
  const s = scope();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const executor: Executor = {
    observe: async () => undefined,
    verify: async () => undefined,
    run: async (input: ExecuteInput) => {
      calls++;
      started();
      return runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        signal: input.signal,
        timeoutMs: 5000,
      });
    },
  };
  const output: string[] = [];
  const chat = new ChatOrchestrator(store, executor, async (_channel, text) => {
    output.push(text);
  });
  const message = (content: string, id = randomUUID()) => ({
    id,
    guild_id: s.guild,
    channel_id: s.channel,
    author: { id: s.owner },
    content: `라피야! ${content}`,
  });
  try {
    const request = message("오류 고쳐줘");
    const running = chat.receive(request);
    await ready;
    await chat.receive(request);
    assert.equal(calls, 1);
    await chat.receive(message("지금 뭐 하는 중이야?"));
    assert.ok(output.some((text) => text.includes("실행 중")));
    assert.ok(
      (await chat.cancel({ ...s, owner: "different" })).includes("없습니다"),
    );
    await chat.receive(message("멈춰"));
    await running;
    const run = (await store.recent(s))[0];
    assert.equal(run?.phase, "cancelled");
    const events = await db.pool.query<{ phase: string }>(
      "SELECT phase FROM chatops_events WHERE run_id=$1 ORDER BY seq",
      [run.id],
    );
    assert.ok(events.rows.some((e) => e.phase === "cancel_requested"));
    assert.equal(events.rows.at(-1)?.phase, "cancelled");
    assert.equal(calls, 1);
  } finally {
    await chat.shutdown();
    await db.close();
  }
});
test("goal loop persists failed attempts and stops after bounded progress", async () => {
  const db = new PostgresStore(url);
  const store = new ChatOpsStore(db);
  const s = scope();
  let calls = 0;
  let observations = 0;
  const executor: Executor = {
    observe: async () => ({
      head: "abc",
      status: "",
      digest: textDigest(String(observations++)),
    }),
    verify: async () => undefined,
    run: async () => {
      calls++;
      return {
        exitCode: 1,
        signal: null,
        reason: "exit",
        output: "실패",
        blocked: false,
      };
    },
  };
  const chat = new ChatOrchestrator(store, executor, async () => undefined);
  try {
    await chat.receive({
      id: randomUUID(),
      guild_id: s.guild,
      channel_id: s.channel,
      author: { id: s.owner },
      content: "라피야! 테스트가 될 때까지 고쳐줘",
    });
    assert.equal(calls, 3);
    const run = (await store.recent(s))[0];
    assert.equal(run?.phase, "failed");
    assert.equal(run.evidence.reason, "budget");
    const attempts = await db.pool.query(
      "SELECT * FROM chatops_events WHERE run_id=$1 AND evidence->>'exitCode'='1' AND phase='running'",
      [run.id],
    );
    assert.equal(attempts.rowCount, 3);
  } finally {
    await chat.shutdown();
    await db.close();
  }
});

test("same-channel queue persists prepared runs and zero exit remains reported_done", async () => {
  const db = new PostgresStore(url);
  const store = new ChatOpsStore(db);
  const s = scope();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  let parallel = 0;
  let maximum = 0;
  const executor: Executor = {
    observe: async () => undefined,
    verify: async () => undefined,
    run: async () => {
      parallel++;
      maximum = Math.max(maximum, parallel);
      calls++;
      if (calls === 1) {
        started();
        await gate;
      }
      parallel--;
      return {
        exitCode: 0,
        signal: null,
        reason: "exit",
        output: "완료 보고",
        blocked: false,
      };
    },
  };
  const chat = new ChatOrchestrator(store, executor, async () => undefined);
  const message = () => ({
    id: randomUUID(),
    guild_id: s.guild,
    channel_id: s.channel,
    author: { id: s.owner },
    content: "라피야! 고쳐줘",
  });
  try {
    const first = chat.receive(message());
    await ready;
    const second = chat.receive(message());
    for (let i = 0; i < 20; i++) {
      if ((await store.recent(s)).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const queued = await store.recent(s);
    assert.equal(queued.length, 2);
    assert.ok(queued.some((r) => r.phase === "prepared"));
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(maximum, 1);
    assert.equal(calls, 2);
    assert.ok(
      (await store.recent(s)).every((r) => r.phase === "reported_done"),
    );
  } finally {
    release();
    await chat.shutdown();
    await db.close();
  }
});

test("explicit memory UX is deduplicated and injected as bounded data into read-only answers", async () => {
  const db = new PostgresStore(url);
  const store = new ChatOpsStore(db);
  const s = scope();
  const prompts: ExecuteInput[] = [];
  const output: string[] = [];
  const executor: Executor = {
    observe: async () => undefined,
    verify: async () => undefined,
    run: async (input) => {
      prompts.push(input);
      return {
        exitCode: 0,
        signal: null,
        reason: "exit",
        output: "답변",
        blocked: false,
      };
    },
  };
  const chat = new ChatOrchestrator(store, executor, async (_channel, text) => {
    output.push(text);
  });
  const message = (content: string) => ({
    id: randomUUID(),
    guild_id: s.guild,
    channel_id: s.channel,
    author: { id: s.owner },
    content: `라피야! ${content}`,
  });
  try {
    const request = message("기억해줘: 한국어를 기본으로 사용");
    await chat.receive(request);
    await chat.receive(request);
    const memories = await store.memories(s);
    assert.equal(memories.length, 1);
    assert.ok(output[0]?.includes("되돌리기"));
    assert.ok(output[0]?.includes(memories[0]!.id));
    await chat.receive(message("어떤 언어가 좋아?"));
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.execute, false);
    assert.ok(prompts[0].prompt.includes(memories[0]!.digest));
    await chat.receive(message(`기억 ${memories[0]!.id} 잊어줘`));
    assert.equal((await store.memories(s)).length, 0);
    assert.equal(prompts.length, 1);
  } finally {
    await chat.shutdown();
    await db.close();
  }
});
