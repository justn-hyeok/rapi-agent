import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRapiInvocation } from "@rapi/contracts";
import type { ChatOpsStore } from "@rapi/db";
import { ChatOrchestrator } from "../apps/chat/src/orchestrator.js";
import type { Executor } from "../apps/chat/src/executor.js";
import { DiscordTyping } from "../apps/chat/src/typing.js";

test("ordinary ways of addressing Rapi are accepted without matching unrelated words", () => {
  for (const text of [
    "라피! 오늘 주요 ai 뉴스 찾아줘",
    "라피야! 오늘 주요 ai 뉴스 찾아줘",
    "라피 오늘 주요 ai 뉴스 찾아줘",
    "라피야 오늘 주요 ai 뉴스 찾아줘",
    "  라피, 오늘 주요 ai 뉴스 찾아줘",
    "라피야!오늘 주요 ai 뉴스 찾아줘",
  ])
    assert.equal(parseRapiInvocation(text), "오늘 주요 ai 뉴스 찾아줘");
  for (const text of [
    "오늘 뉴스 찾아줘",
    "라피스 이야기",
    "라피야구 이야기",
    '"라피!"라고 보냈어',
    "내가 라피!라고 했어",
  ])
    assert.equal(parseRapiInvocation(text), null);
});

test("the reported 라피! message reaches the public responder and replies once", async () => {
  const inputs: string[] = [];
  const replies: string[] = [];
  const typingSignals: AbortSignal[] = [];
  const chat = new ChatOrchestrator(
    {} as ChatOpsStore,
    {} as Executor,
    async (_channel, text) => {
      replies.push(text);
    },
    {
      async isAdminChannel() {
        return false;
      },
      async answer(input) {
        assert.equal(typingSignals.length, 1);
        assert.equal(typingSignals[0]!.aborted, false);
        inputs.push(input.text);
        assert.equal(input.requestId, "1553952792266416280");
        assert.equal(input.tier, "user");
        return "확인한 뉴스입니다.";
      },
    },
    new DiscordTyping(async (channel, signal) => {
      assert.equal(channel, "1553943104950636544");
      typingSignals.push(signal);
    }),
  );
  await chat.receive(
    {
      id: "1553952792266416280",
      guild_id: "1545832299671847013",
      channel_id: "1553943104950636544",
      content: "라피! 오늘 주요 ai 뉴스 찾아줘",
      author: { id: "member" },
    },
    "user",
  );
  assert.deepEqual(inputs, ["오늘 주요 ai 뉴스 찾아줘"]);
  assert.deepEqual(replies, ["확인한 뉴스입니다."]);
  assert.equal(typingSignals[0]!.aborted, true);
});
