import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresStore } from "@rapi/db";
import {
  RapiAgent,
  RecordingDeliveryAdapter,
  RecordingOmpAdapter,
} from "@rapi/agent";

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== "/rapi_test")
  throw new Error("Scheduled delivery E2E requires rapi_test");

for (const cadence of ["daily", "immediate"] as const) {
  test(`${cadence} delivery retains later arrivals, retries after restart gaps, and never resends success`, async () => {
    const store = new PostgresStore(url);
    const delivery = new RecordingDeliveryAdapter();
    const agent = new RapiAgent(store, delivery, new RecordingOmpAdapter());
    try {
      await store.resetForTests();
      const source = await agent.createSource(
        "rss",
        "https://example.com/schedule",
        "public",
      );
      await agent.createSubscription({
        ownerId: "owner",
        name: "schedule",
        sourceIds: [source],
        categories: [],
        includeKeywords: [],
        excludeKeywords: [],
        cadence,
        timezone: "Asia/Seoul",
        channels: [{ channel: "discord_dm", recipientId: "owner" }],
        maxItems: 5,
      });
      const early = new Date("2026-09-27T15:01:00Z");
      await agent.runScheduledDeliveries(early);
      assert.equal(delivery.messages.length, 0);
      await agent.ingestExternalItem(
        source,
        {
          externalId: "late",
          title: "Later news",
          url: "https://example.com/later",
          body: "Arrived after the first tick",
          author: null,
          publishedAt: "2026-09-27T15:02:00Z",
          metadata: {},
        },
        new Date("2026-09-27T15:02:00Z"),
      );
      if (cadence === "daily") {
        await agent.runScheduledDeliveries(new Date("2026-09-27T15:05:00Z"));
        assert.equal(delivery.messages.length, 0);
      }
      const later = new Date(
        cadence === "daily" ? "2026-09-28T15:05:00Z" : "2026-09-27T15:10:00Z",
      );
      await agent.runScheduledDeliveries(later);
      assert.equal(delivery.messages.length, 1);
      assert.match(delivery.messages[0]!.payload.text, /Later news/);
      await agent.runScheduledDeliveries(new Date(later.getTime() + 60_000));
      assert.equal(delivery.messages.length, 1);
    } finally {
      await store.close();
    }
  });
}
