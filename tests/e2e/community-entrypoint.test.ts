import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { PostgresStore } from "@rapi/db";
import {
  DiscordCommandService,
  PublicCommunityService,
  RapiAgent,
  RecordingDeliveryAdapter,
  RecordingOmpAdapter,
} from "@rapi/agent";
import { createDiscordInteractionServer } from "../../apps/bot/src/discord-http.js";

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== "/rapi_test")
  throw new Error("Community entrypoint E2E requires rapi_test");

test("signed Discord requests enforce USER/ADMIN/SUPERADMIN and isolate quota failures", async () => {
  const store = new PostgresStore(url);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = (
    keys.publicKey.export({ type: "spki", format: "der" }) as Buffer
  )
    .subarray(-32)
    .toString("hex");
  let calls = 0;
  const community = new PublicCommunityService(store, {
    async answer(_prompt, onStarted) {
      calls++;
      await onStarted();
      return { started: true, ok: true, output: "공개 답변", reason: "exit" };
    },
  });
  const agent = new RapiAgent(
    store,
    new RecordingDeliveryAdapter(),
    new RecordingOmpAdapter(),
  );
  const commands = new DiscordCommandService(
    agent,
    {
      userIds: ["owner"],
      guildIds: ["community"],
      channelIds: ["questions"],
      userRoleIds: ["USER"],
      adminRoleIds: ["ADMIN"],
      guildMembersAreUsers: false,
    },
    {
      status: async () => "운영 정상",
      publicBrief: (guildId, userId, requestId, tier) =>
        community
          .answer({ guildId, userId, requestId, tier, text: "브리핑" })
          .then((text) => text ?? "중복 요청"),
    },
  );
  const server = createDiscordInteractionServer(commands, publicKey);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  let sequence = 0;
  const invoke = async (
    user: string,
    roles: string[],
    name: string,
    guild = "community",
  ) => {
    const body = Buffer.from(
      JSON.stringify({
        id: `entry-${++sequence}`,
        type: 2,
        guild_id: guild,
        channel_id: "questions",
        member: { user: { id: user }, roles },
        data: { name, options: [] },
      }),
    );
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), body]),
      keys.privateKey,
    ).toString("hex");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/interactions`,
      {
        method: "POST",
        headers: {
          "x-signature-ed25519": signature,
          "x-signature-timestamp": timestamp,
        },
        body,
      },
    );
    assert.equal(response.status, 200);
    return (await response.json()) as {
      type: number;
      data: { content: string; flags: number };
    };
  };
  try {
    await store.resetForTests();
    await store.upsertAiUsagePolicy({
      guildId: "community",
      userDailyLimit: 1,
      userCooldownSeconds: 0,
      globalDailyLimit: 1,
      globalConcurrency: 2,
      timezone: "Asia/Seoul",
      resetHour: 5,
      resetMinute: 30,
    });
    assert.equal(
      (await invoke("member", ["USER"], "브리핑")).data.content,
      "공개 답변",
    );
    assert.match(
      (await invoke("member", ["USER"], "브리핑")).data.content,
      /한도/,
    );
    const denied = await invoke("member", ["USER"], "상태");
    assert.match(denied.data.content, /ADMIN/);
    assert.equal(denied.data.flags, 64);
    assert.equal(
      (await invoke("staff", ["ADMIN"], "상태")).data.content,
      "운영 정상",
    );
    assert.match(
      (await invoke("staff", ["ADMIN"], "작업")).data.content,
      /SUPERADMIN/,
    );
    assert.equal(
      (await invoke("staff", ["ADMIN"], "브리핑")).data.content,
      "공개 답변",
    );
    assert.equal(
      (await invoke("owner", [], "브리핑")).data.content,
      "공개 답변",
    );
    assert.match(
      (await invoke("unknown", [], "브리핑")).data.content,
      /not allowed/,
    );
    assert.match(
      (await invoke("owner", [], "브리핑", "elsewhere")).data.content,
      /guild is not allowed/,
    );
    assert.equal(calls, 3);
    assert.equal((await store.aiUsageStatus("community", "member")).used, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await store.close();
  }
});

test("failed public execution before start does not consume quota", async () => {
  const store = new PostgresStore(url);
  try {
    await store.resetForTests();
    const community = new PublicCommunityService(store, {
      async answer() {
        return { started: false, ok: false, output: "", reason: "spawn_error" };
      },
    });
    assert.match(
      (await community.answer({
        guildId: "community",
        userId: "member",
        requestId: "unstarted",
        tier: "user",
        text: "질문",
      }))!,
      /차감되지/,
    );
    assert.equal((await store.aiUsageStatus("community", "member")).used, 0);
  } finally {
    await store.close();
  }
});
