import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  normalizeGitHubWebhook,
  parseDiscordWebhookUrl,
  webhookRetryDecision,
  DiscordWebhookClient,
} from "@rapi/adapters";

describe("managed webhooks", () => {
  it("encrypts secrets with authenticated encryption", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptSecret("top-secret", key);
    assert.notEqual(encrypted, "top-secret");
    assert.equal(decryptSecret(encrypted, key), "top-secret");
    assert.throws(() => decryptSecret(`${encrypted}x`, key));
  });

  it("accepts only official HTTPS Discord webhook URLs", () => {
    assert.deepEqual(
      parseDiscordWebhookUrl(
        "https://discord.com/api/webhooks/123456789012345678/abc_DEF-123",
      ),
      { id: "123456789012345678", token: "abc_DEF-123" },
    );
    assert.throws(() =>
      parseDiscordWebhookUrl("http://discord.com/api/webhooks/1/token"),
    );
    assert.throws(() =>
      parseDiscordWebhookUrl("https://evil.example/api/webhooks/1/token"),
    );
  });

  it("normalizes supported GitHub webhook payloads", () => {
    const item = normalizeGitHubWebhook("pull_request", {
      action: "opened",
      repository: { full_name: "openai/rapi" },
      pull_request: {
        id: 42,
        html_url: "https://github.com/openai/rapi/pull/2",
        title: "Add health checks",
        body: "Tracks readiness",
        user: { login: "octocat" },
        updated_at: "2026-09-10T00:00:00Z",
      },
    });
    assert.equal(item.externalId, "pull_request:42:opened");
    assert.equal(item.title, "Add health checks");
    assert.equal(item.metadata.eventType, "pull_request");
    assert.throws(() => normalizeGitHubWebhook("fork", {}), /Unsupported/);
  });

  it("classifies Discord retry responses", () => {
    assert.deepEqual(webhookRetryDecision(429, { retry_after: 1.25 }, 2), {
      retry: true,
      delayMs: 1250,
    });
    assert.deepEqual(webhookRetryDecision(503, {}, 2), {
      retry: true,
      delayMs: 4000,
    });
    assert.deepEqual(webhookRetryDecision(404, {}, 2), {
      retry: false,
      delayMs: 0,
    });
  });

  it("verifies and sends Discord webhooks without redirects or mentions", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new DiscordWebhookClient(async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return new Response(
        init.method === "GET"
          ? JSON.stringify({
              id: "123456789012345678",
              channel_id: "987654321098765432",
              guild_id: "222222222222222222",
            })
          : JSON.stringify({ id: "111111111111111111" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const url =
      "https://discord.com/api/webhooks/123456789012345678/abc_DEF-123";
    assert.deepEqual(await client.inspect(url), {
      id: "123456789012345678",
      channelId: "987654321098765432",
      guildId: "222222222222222222",
    });
    await client.send(url, "hello");
    assert.equal(requests[0]?.init.redirect, "manual");
    assert.match(requests[1]?.url ?? "", /wait=true/);
    assert.equal(typeof requests[1]?.init.body, "string");
    assert.deepEqual(JSON.parse(requests[1]?.init.body as string), {
      content: "hello",
      allowed_mentions: { parse: [] },
    });
  });
});
