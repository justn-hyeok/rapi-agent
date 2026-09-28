import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordTyping } from "../apps/chat/src/typing.js";
import { ChatOrchestrator } from "../apps/chat/src/orchestrator.js";
import type { ChatOpsStore } from "@rapi/db";
import type { Executor } from "../apps/chat/src/executor.js";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("typing starts immediately, renews past ten seconds, and stops on completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sent: string[] = [];
  const typing = new DiscordTyping(async (channel) => {
    sent.push(channel);
  });
  const pending = deferred<string>();
  const result = typing.run("channel", () => pending.promise);
  assert.deepEqual(sent, ["channel"]);
  await flush();
  t.mock.timers.tick(8_000);
  await flush();
  t.mock.timers.tick(8_000);
  await flush();
  assert.equal(sent.length, 3);
  pending.resolve("answer");
  assert.equal(await result, "answer");
  t.mock.timers.tick(24_000);
  assert.equal(sent.length, 3);
});

test("overlapping questions share a heartbeat until both finish", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let sent = 0;
  const typing = new DiscordTyping(async () => {
    sent++;
  });
  const first = deferred<undefined>();
  const second = deferred<undefined>();
  const a = typing.run("same", () => first.promise);
  const b = typing.run("same", () => second.promise);
  assert.equal(sent, 1);
  first.resolve(undefined);
  await a;
  t.mock.timers.tick(8_000);
  await flush();
  assert.equal(sent, 2);
  second.resolve(undefined);
  await b;
  t.mock.timers.tick(16_000);
  assert.equal(sent, 2);
});

test("typing failures cannot block answers, and failed work clears its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let sent = 0;
  const typing = new DiscordTyping(async () => {
    sent++;
    throw new Error("Discord unavailable");
  });
  assert.equal(await typing.run("channel", async () => "answer"), "answer");
  await assert.rejects(
    typing.run("channel", async () => {
      throw new Error("model failed");
    }),
    /model failed/,
  );
  await flush();
  t.mock.timers.tick(24_000);
  assert.equal(sent, 2);
});

test("slow typing requests do not overlap or delay work and are aborted at the end", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const signals: AbortSignal[] = [];
  const typing = new DiscordTyping(async (_channel, signal) => {
    signals.push(signal);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const pending = deferred<undefined>();
  const result = typing.run("channel", () => pending.promise);
  t.mock.timers.tick(24_000);
  assert.equal(signals.length, 1);
  pending.resolve(undefined);
  await result;
  assert.equal(signals[0]!.aborted, true);
  await flush();
  t.mock.timers.tick(24_000);
  assert.equal(signals.length, 1);
});

test("private answers show typing during model work and clear it before returning", async () => {
  let signal: AbortSignal | undefined;
  const replies: string[] = [];
  const chat = new ChatOrchestrator(
    {
      async claim() {
        return { inserted: true };
      },
      async memories() {
        return [];
      },
      db: {
        async recentChatMessages() {
          return [];
        },
        async appendChatMessage() {},
      },
    } as unknown as ChatOpsStore,
    {
      async observe() {},
      async run() {
        assert.equal(signal?.aborted, false);
        return {
          output: "답변입니다.",
          exitCode: 0,
          reason: "exit",
          signal: null,
        };
      },
    } as unknown as Executor,
    async (_channel, text) => {
      replies.push(text);
    },
    undefined,
    new DiscordTyping(async (_channel, activeSignal) => {
      signal = activeSignal;
    }),
  );
  await chat.receive({
    id: "1",
    guild_id: "guild",
    channel_id: "private",
    author: { id: "owner" },
    content: "라피! 안녕",
  });
  assert.deepEqual(replies, ["답변입니다."]);
  assert.equal(signal?.aborted, true);
});

test("public execution requests are refused without starting typing or work", async () => {
  let sent = 0;
  let answered = 0;
  const chat = new ChatOrchestrator(
    {} as ChatOpsStore,
    {} as Executor,
    async () => {},
    {
      async isAdminChannel() {
        return false;
      },
      async answer() {
        answered++;
        return "unexpected";
      },
    },
    new DiscordTyping(async () => {
      sent++;
    }),
  );
  await chat.receive(
    {
      id: "2",
      guild_id: "guild",
      channel_id: "public",
      author: { id: "member" },
      content: "라피! 실행: 파일 수정해줘",
    },
    "user",
  );
  assert.equal(answered, 0);
  assert.equal(sent, 0);
});
