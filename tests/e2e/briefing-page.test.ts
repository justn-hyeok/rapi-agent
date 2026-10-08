import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RapiAgent,
  RecordingDeliveryAdapter,
  RecordingOmpAdapter,
} from "@rapi/agent";
import { briefingLinkKey } from "@rapi/core";
import { PostgresStore } from "@rapi/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Briefing E2E requires rapi_test");

describe("briefing page", () => {
  it("serves the owner's batch through a signed link and records exclusive reactions", async () => {
    const store = new PostgresStore(databaseUrl);
    const agent = new RapiAgent(
      store,
      new RecordingDeliveryAdapter(),
      new RecordingOmpAdapter(),
      undefined,
      undefined,
      { key: briefingLinkKey("k".repeat(32)), baseUrl: "https://rapi.example" },
    );
    try {
      await store.resetForTests();
      const source = await agent.createSource(
        "rss",
        "https://news.example/feed",
        "public",
      );
      await agent.ingestExternalItem(
        source,
        {
          externalId: "n-1",
          url: "https://news.example/posts/1",
          title: "Agents <ship>",
          body: "A new agent runtime shipped.",
          author: null,
          publishedAt: "2026-09-08T00:10:00Z",
          metadata: {},
        },
        new Date("2026-09-08T01:00:00Z"),
      );
      const subscription = await agent.createSubscription({
        ownerId: "owner-1",
        name: "daily",
        sourceIds: [source],
        categories: [],
        includeKeywords: [],
        excludeKeywords: [],
        cadence: "daily",
        timezone: "UTC",
        channels: [{ channel: "discord_dm", recipientId: "owner-1" }],
        maxItems: 20,
      });
      const batch = await agent.freezeBatch(
        subscription,
        new Date("2026-09-08T00:00:00Z"),
        new Date("2026-09-09T00:00:00Z"),
      );
      const link = new URL(agent.briefingLink(batch.id)!);
      assert.equal(link.origin, "https://rapi.example");
      const token = link.searchParams.get("t")!;

      assert.equal(await agent.briefingPage(batch.id, "1.bad"), undefined);
      const page = await agent.briefingPage(batch.id, token);
      assert.ok(page);
      assert.match(page.html, /Agents &lt;ship&gt;/);
      assert.match(page.html, /news\.example/);
      const itemId = batch.items[0]!.id;

      assert.equal(
        await agent.recordBriefingFeedback(batch.id, "1.bad", {
          itemId,
          kind: "up",
          on: true,
        }),
        "forbidden",
      );
      assert.equal(
        await agent.recordBriefingFeedback(batch.id, token, {
          itemId: "nope",
          kind: "up",
          on: true,
        }),
        "invalid",
      );
      assert.equal(
        await agent.recordBriefingFeedback(batch.id, token, {
          itemId,
          kind: "up",
          on: true,
        }),
        "ok",
      );
      assert.equal(
        await agent.recordBriefingFeedback(batch.id, token, {
          itemId,
          kind: "down",
          on: true,
        }),
        "ok",
      );
      assert.equal(
        await agent.recordBriefingFeedback(batch.id, token, {
          itemId,
          kind: "save",
          on: true,
        }),
        "ok",
      );
      const rows = await store.pool.query<{ kind: string; active: boolean }>(
        "SELECT kind,active FROM item_feedback WHERE item_id=$1 AND owner_id='owner-1' ORDER BY kind",
        [itemId],
      );
      assert.deepEqual(rows.rows, [
        { kind: "down", active: true },
        { kind: "save", active: true },
        { kind: "up", active: false },
      ]);
      const after = await agent.briefingPage(batch.id, token);
      assert.match(after!.html, /data-k="down" aria-pressed="true"/);
      assert.match(after!.html, /data-k="save" aria-pressed="true"/);
    } finally {
      await store.close();
    }
  });
});
