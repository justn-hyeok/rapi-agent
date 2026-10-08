import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RapiAgent,
  RecordingDeliveryAdapter,
  RecordingOmpAdapter,
} from "@rapi/agent";
import { PostgresStore } from "@rapi/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Private scope E2E requires rapi_test");

describe("private source scope", () => {
  it("delivers private items only to their owner's explicit subscription", async () => {
    const store = new PostgresStore(databaseUrl);
    const agent = new RapiAgent(
      store,
      new RecordingDeliveryAdapter(),
      new RecordingOmpAdapter(),
    );
    try {
      await store.resetForTests();
      const at = new Date("2026-09-08T01:00:00Z");
      const item = (externalId: string, title: string) => ({
        externalId,
        url: `https://x.example/${externalId}`,
        title,
        body: "b",
        author: null,
        publishedAt: "2026-09-08T00:30:00Z",
        metadata: {},
      });
      const publicSource = await agent.createSource(
        "rss",
        "https://public.example/feed",
        "public",
      );
      const owned = await agent.createSource(
        "rss",
        "env:OWNER_FEED_URL",
        "private",
      );
      const ownerless = await agent.createSource(
        "github_stars",
        "owner-1",
        "private",
      );
      await store.pool.query(
        `UPDATE sources SET collection_policy=collection_policy||'{"ownerId":"owner-1"}'::jsonb WHERE id=$1`,
        [owned],
      );
      await agent.ingestExternalItem(
        publicSource,
        item("p", "Public news"),
        at,
      );
      await agent.ingestExternalItem(
        owned,
        item("o", "Owner GitHub activity"),
        at,
      );
      await agent.ingestExternalItem(
        ownerless,
        item("s", "Owner star pick"),
        at,
      );
      const subscribe = (ownerId: string, sourceIds: string[]) =>
        agent.createSubscription({
          ownerId,
          name: `${ownerId}-${sourceIds.length}`,
          sourceIds,
          categories: [],
          includeKeywords: [],
          excludeKeywords: [],
          cadence: "daily",
          timezone: "UTC",
          channels: [{ channel: "discord_dm", recipientId: ownerId }],
          maxItems: 20,
        });
      const titles = async (subscription: string) =>
        (
          await agent.freezeBatch(
            subscription,
            new Date("2026-09-08T00:00:00Z"),
            new Date("2026-09-09T00:00:00Z"),
          )
        ).items
          .map((i) => i.title)
          .sort();

      assert.deepEqual(await titles(await subscribe("friend", [])), [
        "Public news",
      ]);
      assert.deepEqual(
        await titles(
          await subscribe("friend", [owned, ownerless, publicSource]),
        ),
        ["Public news"],
      );
      assert.deepEqual(await titles(await subscribe("owner-1", [])), [
        "Public news",
      ]);
      assert.deepEqual(
        await titles(
          await subscribe("owner-1", [owned, ownerless, publicSource]),
        ),
        ["Owner GitHub activity", "Public news"],
      );
    } finally {
      await store.close();
    }
  });
});
