import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import type { DiscordCommandResult, DiscordCommandService } from "@rapi/agent";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";

test("cancellation acknowledges before work ends and delivers every reply chunk", async (t) => {
  let finish!: (result: DiscordCommandResult) => void;
  const pending = new Promise<DiscordCommandResult>((resolve) => {
    finish = resolve;
  });
  const keys = generateKeyPairSync("ed25519");
  const key = (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("hex");
  const server = createDiscordInteractionServer(
    { execute: async () => pending } as unknown as DiscordCommandService,
    key,
  );
  const fetchRequest = globalThis.fetch;
  const delivered: Array<{ method: string; content: string }> = [];
  let completed!: () => void;
  const deliveryComplete = new Promise<void>((resolve) => {
    completed = resolve;
  });
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
      if (
        url.startsWith(
          "https://discord.com/api/v10/webhooks/fixture-application/fixture-token",
        )
      ) {
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON request body");
        const body = JSON.parse(init.body) as {
          content: string;
          allowed_mentions: { parse: string[] };
        };
        assert.deepEqual(body.allowed_mentions.parse, []);
        delivered.push({
          method: init.method ?? "GET",
          content: body.content,
        });
        if (delivered.length === 2) completed();
        return new Response(null, { status: 204 });
      }
      return fetchRequest(input, init);
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const body = Buffer.from(
      JSON.stringify({
        type: 2,
        id: "fixture",
        application_id: "fixture-application",
        token: "fixture-token",
        guild_id: "guild",
        channel_id: "admin",
        member: { user: { id: "owner" }, roles: [] },
        data: { name: "취소", options: [] },
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
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
    assert.equal(delivered.length, 0);
    finish({ messages: ["중단을 확인했습니다.", "추가 근거입니다."] });
    const timeout = setTimeout(() => completed(), 3_000);
    await deliveryComplete;
    clearTimeout(timeout);
    assert.deepEqual(delivered, [
      { method: "PATCH", content: "중단을 확인했습니다." },
      { method: "POST", content: "추가 근거입니다." },
    ]);
  } finally {
    finish({ messages: ["종료"] });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
