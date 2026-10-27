import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import {
  composeButtonMessage,
  decideGuildButton,
  isGuildDecision,
  type ButtonOutcome,
  type DiscordCommandService,
  type GuildDecisionPorts,
} from "@rapi/agent";
import { GUILD_NOT_ALLOWED_MESSAGE } from "@rapi/core";
import {
  DiscordCommandService as CommandService,
  type RapiAgent,
} from "@rapi/agent";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";
import { ChatOrchestrator } from "../apps/chat/src/orchestrator.js";
import {
  NON_OWNER_HARNESS_NOTICE,
  SENPI_LOGIN_HINT,
  isIgnoredHarnessPrefix,
  withSenpiLoginHint,
} from "../apps/chat/src/harness.js";
import { fakes } from "./helpers/chat-fakes.js";

const WHEN = new Date("2026-10-26T01:00:00Z");

test("a decision leaves who, when and the result under the original text", () => {
  const text = composeButtonMessage(
    "**미리보기**\n• 항목",
    { result: "발송했어요." },
    "42",
    WHEN,
  );
  assert.ok(text.startsWith("**미리보기**\n• 항목"));
  assert.match(text, /발송했어요\./);
  assert.match(text, /<@42>/);
  assert.match(text, /<t:1792976400:f>/);
});

test("a confirm prompt is replaced, never stacked, and the final text stays under the limit", () => {
  const first = composeButtonMessage(
    "초안",
    { prompt: "정말 버릴까요?" },
    "42",
    WHEN,
  );
  assert.match(first, /❓ 정말 버릴까요\?/);
  const back = composeButtonMessage(first, {}, "42", WHEN);
  assert.equal(back, "초안");
  const done = composeButtonMessage(first, { result: "버렸어요." }, "42", WHEN);
  assert.ok(!done.includes("정말 버릴까요"));
  const long = composeButtonMessage(
    "가".repeat(3000),
    { result: "끝" },
    "42",
    WHEN,
  );
  assert.ok(long.length <= 2000);
  assert.match(long, /처리: <@42>/);
});

function ports(overrides: Partial<GuildDecisionPorts> = {}) {
  const log: string[] = [];
  const port: GuildDecisionPorts = {
    decide: async (guild, status, actor) => {
      log.push(`decide:${guild}:${status}:${actor}`);
      return true;
    },
    invalidate: () => void log.push("invalidate"),
    leave: async () => true,
    registerCommands: async (guild) => void log.push(`register:${guild}`),
    ...overrides,
  };
  return { port, log };
}

test("[허용] tells the owner the next step, with the web page only when the web is on", async () => {
  const slash = ports();
  const allowed = await decideGuildButton(slash.port, "guild_allow:123", "9");
  assert.match(allowed.result ?? "", /허용했습니다/);
  assert.match(allowed.result ?? "", /\/서버구성/);
  assert.ok(!(allowed.result ?? "").includes("https://"));
  assert.deepEqual(slash.log, [
    "decide:123:allowed:9",
    "invalidate",
    "register:123",
  ]);
  const web = ports({
    serverConfigUrl: "https://rapi.example/admin/server-config",
  });
  const withWeb = await decideGuildButton(web.port, "guild_allow:123", "9");
  assert.match(
    withWeb.result ?? "",
    /https:\/\/rapi\.example\/admin\/server-config/,
  );
  const failed = ports({
    registerCommands: async () => {
      throw new Error("429");
    },
  });
  const partial = await decideGuildButton(failed.port, "guild_allow:123", "9");
  assert.match(partial.result ?? "", /등록은 실패/);
  assert.match(partial.result ?? "", /다음 단계/);
});

test("[거절], a stale press and a bad id", async () => {
  const left = ports();
  assert.match(
    (await decideGuildButton(left.port, "guild_reject:123", "9")).result ?? "",
    /나갔습니다/,
  );
  const stuck = ports({ leave: async () => false });
  assert.match(
    (await decideGuildButton(stuck.port, "guild_reject:123", "9")).result ?? "",
    /직접 내보내/,
  );
  const stale = ports({ decide: async () => false });
  const outcome = await decideGuildButton(stale.port, "guild_allow:123", "9");
  assert.equal(outcome.result, "이미 처리했거나 요청이 없는 서버입니다.");
  assert.deepEqual(stale.log, ["invalidate"]);
  await assert.rejects(
    decideGuildButton(left.port, "guild_allow:abc", "9"),
    /알 수 없는/,
  );
  assert.ok(isGuildDecision("guild_reject:1"));
  assert.ok(!isGuildDecision("learner_optout"));
  assert.match(GUILD_NOT_ALLOWED_MESSAGE, /운영자/);
});

interface Sent {
  content: string;
  embeds?: Array<{ title?: string; description?: string }>;
  components?: unknown[];
  flags?: number;
  allowed_mentions?: unknown;
}

async function press(
  t: TestContext,
  handle: (customId: string) => Promise<ButtonOutcome>,
  customId: string,
  messageContent = "원래 메시지",
  messageEmbeds: unknown[] = [],
) {
  const keys = generateKeyPairSync("ed25519");
  const key = (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("hex");
  const server = createDiscordInteractionServer(
    {} as unknown as DiscordCommandService,
    key,
    {
      decision: {
        handles: (id) => id.startsWith("x_"),
        handle: (_identity, id) => handle(id),
      },
    },
  );
  const calls: Array<{ url: string; method: string; body: Sent }> = [];
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const realFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith("https://discord.com/api/v10/webhooks/app/tok")) {
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: JSON.parse(
            typeof init?.body === "string" ? init.body : "{}",
          ) as Sent,
        });
        done();
        return new Response(null, { status: 204 });
      }
      return realFetch(input, init);
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const body = Buffer.from(
      JSON.stringify({
        type: 3,
        id: "i",
        application_id: "app",
        token: "tok",
        channel_id: "dm",
        user: { id: "owner" },
        message: { content: messageContent, embeds: messageEmbeds },
        data: { custom_id: customId },
      }),
    );
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(
      `http://127.0.0.1:${address.port}/interactions`,
      {
        method: "POST",
        headers: {
          "x-signature-timestamp": timestamp,
          "x-signature-ed25519": sign(
            null,
            Buffer.concat([Buffer.from(timestamp), body]),
            keys.privateKey,
          ).toString("hex"),
        },
        body,
        signal: AbortSignal.timeout(2_000),
      },
    );
    const ack = (await response.json()) as { type: number };
    await Promise.race([
      finished,
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ]);
    return { ack, calls };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a decision button acknowledges with a deferred update and edits the pressed message", async (t) => {
  const { ack, calls } = await press(
    t,
    async () => ({ result: "서버를 허용했습니다." }),
    "x_ok:1",
  );
  // 6 = DEFERRED_UPDATE_MESSAGE: the next edit lands on the button's own message.
  assert.deepEqual(ack, { type: 6 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "PATCH");
  assert.ok(calls[0]!.url.endsWith("/messages/@original"));
  assert.match(calls[0]!.body.content, /^원래 메시지/);
  assert.match(calls[0]!.body.content, /서버를 허용했습니다\./);
  assert.match(calls[0]!.body.content, /<@owner>/);
  assert.deepEqual(calls[0]!.body.components, []);
  assert.deepEqual(calls[0]!.body.allowed_mentions, { parse: [] });
});

test("a confirm step keeps its buttons; a stale press still answers the state", async (t) => {
  const confirm = await press(
    t,
    async () => ({
      prompt: "정말 버릴까요?",
      components: [{ type: 1, components: [] }],
    }),
    "x_discard:1",
  );
  assert.equal(confirm.calls[0]!.body.components.length, 1);
  assert.match(confirm.calls[0]!.body.content, /정말 버릴까요/);
  const stale = await press(
    t,
    async () => ({ result: "이미 처리했거나 요청이 없는 서버입니다." }),
    "x_ok:1",
  );
  assert.match(stale.calls[0]!.body.content, /이미 처리했거나/);
  assert.deepEqual(stale.calls[0]!.body.components, []);
});

test("a refusal or error is shown only to the presser and leaves the message alone", async (t) => {
  const refusal = await press(
    t,
    async () => ({ notice: "운영자만 쓸 수 있는 버튼입니다." }),
    "x_ok:1",
  );
  assert.equal(refusal.calls.length, 1);
  assert.equal(refusal.calls[0]!.method, "POST");
  assert.equal(refusal.calls[0]!.body.flags, 64);
  assert.equal(refusal.calls[0]!.body.components, undefined);
  const failure = await press(
    t,
    async () => {
      throw new Error("SUPERADMIN 권한이 필요합니다.");
    },
    "x_ok:1",
  );
  assert.equal(failure.calls[0]!.method, "POST");
  assert.equal(failure.calls[0]!.body.flags, 64);
  assert.match(failure.calls[0]!.body.content, /SUPERADMIN/);
});

test("senpi failures that look like a missing login point at the setup docs", () => {
  const failed = withSenpiLoginHint({
    exitCode: 1,
    output: "Error: not logged in. Please login first.",
  });
  assert.ok(failed.startsWith("Error: not logged in."));
  assert.ok(failed.endsWith(SENPI_LOGIN_HINT));
  assert.match(
    SENPI_LOGIN_HINT,
    /senpi 로그인이 필요할 수 있어요: docs\/operations\.md 참고/,
  );
  assert.equal(
    withSenpiLoginHint({ exitCode: 1, output: "TypeError: x is undefined" }),
    "TypeError: x is undefined",
  );
  assert.equal(
    withSenpiLoginHint({ exitCode: 0, output: "logged in as x" }),
    "logged in as x",
  );
});

test("a non-owner's harness prefix gets a one-line note and the request is still handled", async () => {
  assert.ok(isIgnoredHarnessPrefix("센파이로 고쳐줘", "admin"));
  assert.ok(isIgnoredHarnessPrefix("senpi: fix", "user"));
  assert.ok(!isIgnoredHarnessPrefix("센파이로 고쳐줘", "superadmin"));
  assert.ok(!isIgnoredHarnessPrefix("그냥 고쳐줘", "user"));
  const f = fakes();
  const chat = new ChatOrchestrator(f.store, f.executor, f.send);
  await chat.receive(
    {
      id: "m1",
      guild_id: "g1",
      channel_id: "c1",
      content: "라피야! 센파이로 오늘 일정 알려줘",
      author: { id: "u1" },
    },
    "admin",
  );
  assert.equal(f.sent[0]![1], NON_OWNER_HARNESS_NOTICE);
  // The request itself went through the normal answer path.
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0]!.execute, false);
  assert.ok(f.prompts[0]!.prompt.includes("센파이로 오늘 일정 알려줘"));
  // The owner gets no note.
  const owner = fakes();
  const ownerChat = new ChatOrchestrator(
    owner.store,
    owner.executor,
    owner.send,
  );
  await ownerChat.receive(
    {
      id: "m2",
      guild_id: "g1",
      channel_id: "c1",
      content: "라피야! 센파이로 오늘 일정 알려줘",
      author: { id: "u1" },
    },
    "superadmin",
  );
  assert.ok(!owner.sent.some(([, text]) => text === NON_OWNER_HARNESS_NOTICE));
});

test("a running run marked cancel_requested by the bot is stopped by the chat process", async () => {
  const f = fakes();
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  f.executor.run = async (input) => {
    started();
    await new Promise<void>((resolve) => {
      const guard = setTimeout(resolve, 3_000);
      const stop = () => {
        clearTimeout(guard);
        resolve();
      };
      if (input.signal.aborted) stop();
      input.signal.addEventListener("abort", stop);
    });
    return {
      exitCode: null,
      signal: "SIGTERM",
      reason: input.signal.aborted ? "cancel" : "timeout",
      output: "",
      blocked: false,
    };
  };
  const chat = new ChatOrchestrator(f.store, f.executor, f.send);
  chat.cancelPollMs = 20;
  const work = chat.receive(
    {
      id: "m3",
      guild_id: "g1",
      channel_id: "c1",
      content: "라피야! 오류 고쳐줘",
      author: { id: "u1" },
    },
    "superadmin",
  );
  await running;
  // What `/취소` in the bot process does: only flip the phase in the database.
  const runId = "11111111-1111-4111-8111-111111111111";
  await f.store.transition(runId, "running", "cancel_requested");
  const started_at = Date.now();
  await work;
  assert.ok(
    Date.now() - started_at < 2_000,
    "stopped by the poll, not the timeout",
  );
  assert.equal((await f.store.get(runId)).phase, "cancelled");
});

test("/취소 asks the chat process to stop the caller's running ChatOps run", async () => {
  const calls: string[] = [];
  const service = (chatRun: string | null, task: string | null) =>
    new CommandService(
      {
        store: {
          latestCancellableTask: async () => task,
          requestChatOpsCancel: async (owner: string) => {
            calls.push(owner);
            return chatRun;
          },
        },
        cancelTask: async () => void calls.push("task"),
      } as unknown as RapiAgent,
      { userIds: ["owner"] },
    );
  const identity = { userId: "owner" };
  const stopped = await service("run-1", null).execute(identity, {
    name: "cancel",
    options: {},
  });
  assert.match(stopped.messages[0]!, /ChatOps 작업 run-1의 중단을 요청/);
  assert.deepEqual(calls, ["owner"]);
  // An old slash task still wins, and nothing to cancel keeps the old error.
  await service("run-1", "task-1").execute(identity, {
    name: "cancel",
    options: {},
  });
  assert.equal(calls.at(-1), "task");
  await assert.rejects(
    service(null, null).execute(identity, { name: "cancel", options: {} }),
    /취소할 작업이 없습니다/,
  );
});

test("a decision button on an embed message keeps the cards and adds the result card", async (t) => {
  const { calls } = await press(
    t,
    async () => ({ result: "게시했어요." }),
    "x_publish",
    "",
    [{ type: "rich", title: "초안", description: "본문" }],
  );
  assert.equal(calls.length, 1);
  const edit = calls[0]!.body;
  assert.equal(edit.content, "");
  assert.equal(edit.embeds![0]!.title, "초안");
  assert.equal(edit.embeds![1]!.title, "✅ 처리됨");
  assert.match(edit.embeds![1]!.description!, /게시했어요\./);
});
