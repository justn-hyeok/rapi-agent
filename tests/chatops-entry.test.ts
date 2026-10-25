import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CODEX_MODEL } from "@rapi/contracts";
import { ChatOrchestrator } from "../apps/chat/src/orchestrator.js";
import { fakes } from "./helpers/chat-fakes.js";

test("Discord requests keep their claim, replies and executor call", async () => {
  const f = fakes();
  const chat = new ChatOrchestrator(f.store, f.executor, f.send);
  await chat.receive(
    {
      id: "m1",
      guild_id: "g1",
      channel_id: "c1",
      content: "라피야! 오류 고쳐줘",
      author: { id: "u1" },
    },
    "superadmin",
  );
  assert.deepEqual(f.claims, [
    [
      { guild: "g1", channel: "c1", owner: "u1" },
      "m1",
      "오류 고쳐줘",
      "execute",
      DEFAULT_CODEX_MODEL,
    ],
  ]);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0]!.execute, true);
  assert.match(f.prompts[0]!.prompt, /\/home\/justn\/rapi-agent/);
  assert.deepEqual(
    f.sent.map(([channel]) => channel),
    ["c1", "c1", "c1"],
  );
  assert.match(f.sent[0]![1], /작업 .+을 접수했습니다/);
  assert.match(f.sent[1]![1], /실행기 보고\(목표 검증 미확정\):\n끝났습니다/);
  assert.match(f.sent[2]![1], /실행기 완료 보고/);
});

test("Discord users below SUPERADMIN cannot execute", async () => {
  const f = fakes();
  const chat = new ChatOrchestrator(f.store, f.executor, f.send);
  await chat.receive(
    {
      id: "m2",
      guild_id: "g1",
      channel_id: "c1",
      content: "라피야! 오류 고쳐줘",
      author: { id: "u1" },
    },
    "user",
  );
  assert.equal(f.claims.length, 0);
  assert.equal(f.prompts.length, 0);
});
