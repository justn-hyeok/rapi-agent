import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  replaceEnvironmentValue,
  validateDiscordBotToken,
} from "../scripts/update-discord-token.mjs";

describe("Discord token rotation", () => {
  it("replaces the token once while preserving unrelated settings", () => {
    const updated = replaceEnvironmentValue(
      "DATABASE_URL=postgresql://localhost/rapi\nDISCORD_BOT_TOKEN=old\nPORT=3000\nDISCORD_BOT_TOKEN=duplicate\n",
      "DISCORD_BOT_TOKEN",
      "new.token_value",
    );
    assert.equal(
      updated,
      "DATABASE_URL=postgresql://localhost/rapi\nDISCORD_BOT_TOKEN=new.token_value\nPORT=3000\n",
    );
  });

  it("appends a missing token without changing comments", () => {
    assert.equal(
      replaceEnvironmentValue(
        "# Discord configuration\nPORT=3000\n",
        "DISCORD_BOT_TOKEN",
        "new-token",
      ),
      "# Discord configuration\nPORT=3000\nDISCORD_BOT_TOKEN=new-token\n",
    );
  });

  it("rejects values that could create additional environment entries", () => {
    assert.throws(
      () =>
        replaceEnvironmentValue(
          "PORT=3000\n",
          "DISCORD_BOT_TOKEN",
          "token\nINJECTED=true",
        ),
      /single non-empty line/,
    );
  });

  it("validates the credential as a bot token without following redirects", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    await validateDiscordBotToken("a".repeat(24), async (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ id: "123", bot: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call?.init);
    assert.equal(call.init.redirect, "manual");
    assert.equal(
      (call.init.headers as Record<string, string>).authorization,
      `Bot ${"a".repeat(24)}`,
    );
  });

  it("rejects malformed and unauthorized tokens", async () => {
    await assert.rejects(
      validateDiscordBotToken("short", async () => new Response()),
      /format is invalid/,
    );
    await assert.rejects(
      validateDiscordBotToken(
        "a".repeat(24),
        async () => new Response(null, { status: 401 }),
      ),
      /HTTP 401/,
    );
  });
});
