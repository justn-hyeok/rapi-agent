import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresStore } from "@rapi/db";
import { DiscordWebhookClient } from "@rapi/adapters";
import { WebhookDeliveryWorker, WebhookManager } from "@rapi/agent";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Operations E2E requires rapi_test");

describe("managed webhook persistence", () => {
  it("creates scoped connections and atomically deduplicates deliveries", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      const outbound = await store.createWebhookConnection({
        guildId: "guild-1",
        name: "ops-output",
        kind: "discord_outbound",
        eventFilters: [],
        secretCiphertext: "encrypted-url",
      });
      const inbound = await store.createWebhookConnection({
        guildId: "guild-1",
        name: "github-input",
        kind: "github_inbound",
        destinationKind: "discord_webhook",
        destinationId: outbound.id,
        eventFilters: ["pull_request"],
        secretCiphertext: "encrypted-secret",
      });
      assert.ok(inbound.sourceId);
      assert.equal((await store.listWebhookConnections("guild-1")).length, 2);
      assert.equal((await store.listWebhookConnections("guild-2")).length, 0);

      const event = {
        id: randomUUID(),
        rawEventId: randomUUID(),
        sourceId: inbound.sourceId!,
        normalizerVersion: "github-webhook-v1",
        canonicalUrl: "https://github.com/openai/rapi/pull/2",
        title: "Health checks",
        body: "Add readiness",
        author: "octocat",
        publishedAt: new Date("2026-09-10T00:00:00Z"),
        collectedAt: new Date("2026-09-10T00:01:00Z"),
        visibility: "private" as const,
        contentFingerprint: "fingerprint",
        metadata: {},
        categories: ["development"],
      };
      const first = await store.ingestManagedWebhook({
        connectionId: inbound.id,
        deliveryId: "delivery-1",
        eventType: "pull_request",
        payloadHash: "hash-1",
        rawPayload: { action: "opened" },
        item: event,
        summary: "Add readiness",
      });
      const duplicate = await store.ingestManagedWebhook({
        connectionId: inbound.id,
        deliveryId: "delivery-1",
        eventType: "pull_request",
        payloadHash: "hash-1",
        rawPayload: { action: "opened" },
        item: { ...event, id: randomUUID(), rawEventId: randomUUID() },
        summary: "Add readiness",
      });
      assert.equal(first.inserted, true);
      assert.equal(duplicate.inserted, false);
      assert.equal((await store.leaseWebhookJobs(10, 30_000)).length, 1);
      await assert.rejects(
        store.ingestManagedWebhook({
          connectionId: inbound.id,
          deliveryId: "delivery-1",
          eventType: "pull_request",
          payloadHash: "different",
          rawPayload: {},
          item: { ...event, id: randomUUID(), rawEventId: randomUUID() },
          summary: "changed",
        }),
        /conflicting payload/,
      );
    } finally {
      await store.close();
    }
  });

  it("reclaims expired leases and dead-letters exhausted jobs", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      await store.enqueueWebhookJob("job-1", { content: "test" }, 1);
      const [job] = await store.leaseWebhookJobs(1, -1);
      assert.ok(job);
      const [reclaimed] = await store.leaseWebhookJobs(1, 30_000);
      assert.equal(reclaimed?.id, job.id);
      await store.failWebhookJob(job.id, "permanent", 0, false);
      assert.equal((await store.webhookQueueStatus()).deadLetter, 1);
    } finally {
      await store.close();
    }
  });

  it("receives signed GitHub events and delivers them through Discord webhooks", async () => {
    const store = new PostgresStore(databaseUrl);
    const requests: RequestInit[] = [];
    const discord = new DiscordWebhookClient(async (_input, init = {}) => {
      requests.push(init);
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
    const encryptionKey = randomBytes(32).toString("base64");
    const manager = new WebhookManager(store, {
      encryptionKey,
      publicBaseUrl: "https://rapi.example.com",
      discordClient: discord,
    });
    try {
      await store.resetForTests();
      const outbound = await manager.register({
        guildId: "222222222222222222",
        name: "discord",
        kind: "discord_outbound",
        secret:
          "https://discord.com/api/webhooks/123456789012345678/abc_DEF-123",
      });
      const inbound = await manager.register({
        guildId: "222222222222222222",
        name: "github",
        kind: "github_inbound",
        destinationKind: "discord_webhook",
        destinationId: outbound.id,
        eventFilters: ["pull_request"],
      });
      assert.match(inbound.endpoint ?? "", /\/webhooks\/v1\//);
      assert.ok(inbound.secret);
      assert.equal(
        (await manager.list("222222222222222222")).some(
          (item) => "secretCiphertext" in item,
        ),
        false,
      );
      const body = Buffer.from(
        JSON.stringify({
          action: "opened",
          repository: { full_name: "openai/rapi" },
          pull_request: {
            id: 42,
            html_url: "https://github.com/openai/rapi/pull/42",
            title: "Managed webhook",
            body: "Add delivery",
          },
        }),
      );
      const signature = `sha256=${createHmac("sha256", inbound.secret!).update(body).digest("hex")}`;
      assert.equal(
        (
          await manager.receive(inbound.id, body, {
            "x-hub-signature-256": signature,
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-42",
          })
        ).inserted,
        true,
      );
      await assert.rejects(
        manager.receive(inbound.id, body, {
          "x-hub-signature-256": "sha256=bad",
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-43",
        }),
        /signature/i,
      );
      const worker = new WebhookDeliveryWorker(
        store,
        encryptionKey,
        () => Promise.resolve(),
        discord,
      );
      assert.equal(await worker.runOnce(), 1);
      assert.equal(
        requests.filter((request) => request.method === "POST").length,
        1,
      );
      assert.equal((await store.webhookQueueStatus()).done, 1);
    } finally {
      await store.close();
    }
  });

  it("resumes Discord delivery after the last confirmed message chunk", async () => {
    const store = new PostgresStore(databaseUrl);
    const encryptionKey = randomBytes(32).toString("base64");
    let postCount = 0;
    const discord = new DiscordWebhookClient(async (_input, init = {}) => {
      if (init.method === "GET")
        return new Response(
          JSON.stringify({
            id: "123456789012345678",
            channel_id: "987654321098765432",
            guild_id: "222222222222222222",
          }),
          { status: 200 },
        );
      postCount += 1;
      if (postCount === 2)
        return new Response(JSON.stringify({ retry_after: 0 }), {
          status: 429,
        });
      return new Response(JSON.stringify({ id: String(postCount) }), {
        status: 200,
      });
    });
    const manager = new WebhookManager(store, {
      encryptionKey,
      publicBaseUrl: "https://rapi.example.com",
      discordClient: discord,
    });
    try {
      await store.resetForTests();
      const outbound = await manager.register({
        guildId: "222222222222222222",
        name: "chunk-output",
        kind: "discord_outbound",
        secret:
          "https://discord.com/api/webhooks/123456789012345678/abc_DEF-123",
      });
      await store.enqueueWebhookJob("chunk-job", {
        destinationKind: "discord_webhook",
        destinationId: outbound.id,
        title: "Long event",
        summary: "x ".repeat(1200),
        url: "https://example.com/event",
        sentChunks: 0,
      });
      const worker = new WebhookDeliveryWorker(
        store,
        encryptionKey,
        () => Promise.resolve(),
        discord,
      );
      await worker.runOnce();
      assert.equal((await store.webhookQueueStatus()).ready, 1);
      await worker.runOnce();
      assert.equal((await store.webhookQueueStatus()).done, 1);
      assert.equal(postCount, 3);
    } finally {
      await store.close();
    }
  });
});
