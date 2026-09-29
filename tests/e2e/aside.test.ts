import assert from "node:assert/strict";
import { it } from "node:test";
import { PostgresStore } from "@rapi/db";
import {
  AsideCollector,
  RapiAgent,
  RecordingDeliveryAdapter,
  RecordingOmpAdapter,
} from "@rapi/agent";
import { ASIDE_LOCATOR } from "@rapi/adapters";

it("Aside serial leases, retries, atomic private ingestion, dedup and disabled-source fencing", async () => {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).pathname !== "/rapi_test"
  )
    throw new Error("Aside E2E requires rapi_test");
  const store = new PostgresStore(process.env.DATABASE_URL);
  const agent = new RapiAgent(
    store,
    new RecordingDeliveryAdapter(),
    new RecordingOmpAdapter(),
  );
  const collector = new AsideCollector(agent);
  try {
    await store.resetForTests();
    const sourceId = await store.createSource(
      "aside",
      ASIDE_LOCATOR,
      "private",
    );
    await store.pool.query(
      "UPDATE sources SET collection_policy=collection_policy || $2::jsonb WHERE id=$1",
      [
        sourceId,
        JSON.stringify({
          ownerId: "aside-owner",
          aside: { adapter: "hacker-news-v1" },
        }),
      ],
    );
    const claims = await Promise.all([collector.claim(), collector.claim()]);
    assert.equal(claims.filter(Boolean).length, 1);
    let claim = claims.find(Boolean)!;
    const stories = ["123", "456"].map((id) => ({
      id,
      title: `Story ${id}`,
      articleUrl: "https://example.com/" + id,
      author: "test",
    }));
    const snapshot = () => ({
      sourceId: claim.sourceId,
      token: claim.token,
      adapter: claim.adapter,
      pageUrl: ASIDE_LOCATOR,
      stories,
      collectedAt: new Date().toISOString(),
    });
    const complete = () => collector.complete(snapshot());
    assert.deepEqual(await complete(), { inserted: 2, observed: 2 });
    for (const [name, ownerId, sourceIds, channel, recipientId, expected] of [
      ["catch-all", "aside-owner", [], "discord_dm", "aside-owner", 0],
      [
        "other-owner",
        "other-owner",
        [sourceId],
        "discord_dm",
        "other-owner",
        0,
      ],
      [
        "public-channel",
        "aside-owner",
        [sourceId],
        "discord_channel",
        "a-channel",
        0,
      ],
      ["other-dm", "aside-owner", [sourceId], "discord_dm", "other-owner", 0],
      [
        "owner-opt-in",
        "aside-owner",
        [sourceId],
        "discord_dm",
        "aside-owner",
        2,
      ],
    ] as const) {
      const id = await store.createSubscription({
        ownerId,
        name,
        sourceIds: [...sourceIds],
        categories: [],
        includeKeywords: [],
        excludeKeywords: [],
        cadence: "daily",
        timezone: "UTC",
        channels: [{ channel, recipientId }],
        maxItems: 10,
      });
      const batch = await store.freezeBatch(
        id,
        new Date(Date.now() - 60_000),
        new Date(Date.now() + 60_000),
      );
      assert.equal(batch.items.length, expected, name);
    }
    assert.equal(
      (
        await store.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM source_items WHERE visibility<>'private'",
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(complete(), /lease/);
    assert.equal(await collector.claim(), null);
    const due = async () => {
      await store.pool.query(
        "UPDATE source_cursors SET last_success_at=now()-interval '20 minutes',updated_at=now()-interval '2 hours' WHERE source_id=$1",
        [sourceId],
      );
    };
    await due();
    claim = (await collector.claim())!;
    assert.deepEqual(await complete(), { inserted: 0, observed: 2 });
    await due();
    claim = (await collector.claim())!;
    await collector.fail(sourceId, claim.token);
    assert.equal(await collector.claim(), null, "retry must respect backoff");
    await due();
    claim = (await collector.claim())!;
    const old = claim;
    await store.pool.query(
      "UPDATE source_cursors SET modified_at=now()-interval '1 second',updated_at=now()-interval '2 hours' WHERE source_id=$1",
      [sourceId],
    );
    claim = (await collector.claim())!;
    assert.notEqual(claim.token, old.token);
    await assert.rejects(
      collector.complete({
        sourceId,
        token: old.token,
        adapter: old.adapter,
        pageUrl: ASIDE_LOCATOR,
        collectedAt: new Date().toISOString(),
        stories,
      }),
      /lease/,
    );
    // Inject a mid-snapshot error after one ordinary ingest. Nothing may commit.
    const original = agent.ingestExternalItem.bind(agent);
    let calls = 0;
    agent.ingestExternalItem = async (...args) => {
      if (++calls === 2) throw new Error("injected snapshot failure");
      return original(...args);
    };
    stories[0]!.id = "789";
    stories[1]!.id = "999";
    await assert.rejects(complete(), /injected/);
    assert.equal(
      (
        await store.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM source_items",
        )
      ).rows[0].n,
      2,
    );
    agent.ingestExternalItem = original;
    assert.deepEqual(await complete(), { inserted: 2, observed: 2 });
    await due();
    claim = (await collector.claim())!;
    await store.pool.query("UPDATE sources SET state='disabled' WHERE id=$1", [
      sourceId,
    ]);
    await assert.rejects(complete(), /lease/);
    await collector.fail(sourceId, claim.token);
    assert.equal(await collector.claim(), null);
  } finally {
    await store.close();
  }
});
