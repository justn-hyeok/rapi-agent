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
      const preview = await agent.briefingSchedule(batch.id, token, {
        action: "preview",
        text: "2030-01-02 오후 3시 면담",
      });
      assert.equal(preview.status, 200);
      assert.match(JSON.stringify(preview.body), /1\/2 \(수\) 15:00 · 면담/);
      const added = await agent.briefingSchedule(batch.id, token, {
        action: "add",
        text: "2030-01-02 오후 3시 면담",
      });
      assert.equal(added.status, 200);
      const stored = await store.pool.query<{
        id: string;
        owner_id: string;
        title: string;
      }>("SELECT id,owner_id,title FROM events");
      assert.deepEqual(
        stored.rows.map((r) => [r.owner_id, r.title]),
        [["owner-1", "면담"]],
      );
      assert.equal(
        (
          await agent.briefingSchedule(batch.id, token, {
            action: "add",
            text: "날짜 없음",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await agent.briefingSchedule(batch.id, "1.bad", {
            action: "add",
            text: "내일 회의",
          })
        ).status,
        403,
      );
      await store.upsertCollectedEvent({
        externalKey: "devpost:x",
        source: "devpost",
        kind: "deadline",
        title: "[해커톤] X 제출 마감",
        startsAt: new Date(Date.now() + 3 * 86_400_000),
        allDay: true,
        url: "https://x",
        note: null,
      });
      const upcoming = await agent.upcomingEvents("owner-1", 30);
      assert.equal(upcoming.length, 1);
      assert.equal(upcoming[0]!.title, "[해커톤] X 제출 마감");
      await agent.scheduleCommand("owner-1", {
        action: "delete",
        id: upcoming[0]!.id,
      });
      assert.equal((await agent.upcomingEvents("owner-1", 30)).length, 0);
      assert.equal(
        (await store.pool.query("SELECT 1 FROM events WHERE hidden")).rowCount,
        1,
      );
      assert.equal(
        (
          await agent.scheduleCommand("someone-else", {
            action: "delete",
            id: stored.rows[0]!.id,
          })
        ).ok,
        false,
      );
      const after = await agent.briefingPage(batch.id, token);
      assert.match(after!.html, /data-k="down" aria-pressed="true"/);
      assert.match(after!.html, /data-k="save" aria-pressed="true"/);
      // After a like, the liked source and its terms outrank a newer unrelated item.
      assert.equal(
        await agent.recordBriefingFeedback(batch.id, token, {
          itemId,
          kind: "up",
          on: true,
        }),
        "ok",
      );
      const other = await agent.createSource(
        "rss",
        "https://other.example/feed",
        "public",
      );
      for (const [sourceId, externalId, title] of [
        [other, "o-1", "Crypto market weekly"],
        [source, "n-2", "Agents ship faster"],
      ] as const)
        await agent.ingestExternalItem(
          sourceId,
          {
            externalId,
            url: `https://x.example/${externalId}`,
            title,
            body: "body",
            author: null,
            publishedAt:
              externalId === "o-1"
                ? "2026-09-09T05:00:00Z"
                : "2026-09-09T01:00:00Z",
            metadata: {},
          },
          new Date("2026-09-09T06:00:00Z"),
        );
      const subscription2 = await agent.createSubscription({
        ownerId: "owner-1",
        name: "daily-2",
        sourceIds: [],
        categories: [],
        includeKeywords: [],
        excludeKeywords: [],
        cadence: "daily",
        timezone: "UTC",
        channels: [{ channel: "discord_dm", recipientId: "owner-1" }],
        maxItems: 20,
      });
      const ranked = await agent.freezeBatch(
        subscription2,
        new Date("2026-09-09T00:00:00Z"),
        new Date("2026-09-10T00:00:00Z"),
      );
      assert.deepEqual(
        ranked.items.map((i) => i.title),
        ["Agents ship faster", "Crypto market weekly"],
      );

      const detailAgent = new RapiAgent(
        store,
        new RecordingDeliveryAdapter(),
        new RecordingOmpAdapter(),
        {
          policy: "test:model",
          summarize: async () => new Map(),
          detail: async () => ["핵심 하나", "핵심 둘"],
        },
        undefined,
        {
          key: briefingLinkKey("k".repeat(32)),
          baseUrl: "https://rapi.example",
        },
      );
      const detail = await detailAgent.briefingDetail(batch.id, token, itemId);
      assert.deepEqual(detail, {
        status: 200,
        body: { ok: true, points: ["핵심 하나", "핵심 둘"] },
      });
      assert.equal(
        (
          await store.pool.query(
            "SELECT 1 FROM summaries WHERE purpose='detail'",
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await store.pool.query(
            "SELECT 1 FROM item_feedback WHERE kind='open' AND active",
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (await detailAgent.briefingDetail(batch.id, "1.bad", itemId)).status,
        403,
      );
    } finally {
      await store.close();
    }
  });
});
