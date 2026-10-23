import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresStore } from "@rapi/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Learner E2E requires rapi_test");

describe("learner experiment store", () => {
  it("subscribes, issues once, decides once and records clicks, replies and the report", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      for (const table of [
        "learner_reports",
        "learner_replies",
        "learner_clicks",
        "learner_deliveries",
        "learner_issue_items",
        "learner_issues",
        "learner_subscriptions",
      ])
        await store.pool.query(`DELETE FROM ${table}`);
      await store.pool.query("DELETE FROM community_posts");

      await store.learnerSubscribe({
        userId: "u1",
        guildId: "g",
        cadence: "daily",
      });
      await store.learnerSubscribe({
        userId: "u2",
        guildId: "g",
        cadence: "weekly",
      });
      assert.equal(await store.learnerRecordReply("nobody"), false);
      assert.equal(await store.learnerRecordReply("u1"), true);
      assert.deepEqual(await store.learnerActiveSubscribers("daily"), [
        { userId: "u1", emailAsked: false },
      ]);

      await store.recordCommunityPost({
        key: "setup:1",
        feed: "setup",
        channelId: "c",
        messageId: "m",
        data: {},
      });
      await store.recordCommunityPost({
        key: "free-model:x",
        feed: "free-tokens",
        channelId: null,
        messageId: null,
        data: {},
      });
      await store.recordCommunityPost({
        key: "free-models:2026",
        feed: "free-tokens",
        channelId: null,
        messageId: null,
        data: {},
      });
      const posts = await store.learnerCandidatePosts(new Date(0), [
        "free-tokens",
        "setup",
        "stars",
      ]);
      assert.deepEqual(posts.map((post) => post.key).sort(), [
        "free-model:x",
        "setup:1",
      ]);

      const input = {
        cadence: "daily" as const,
        periodKey: "2026-10-26",
        windowStart: new Date("2026-10-25T00:00:00Z"),
        windowEnd: new Date("2026-10-26T00:00:00Z"),
        items: [
          {
            postKey: "setup:1",
            section: "tools" as const,
            title: "설치",
            summary: "",
            url: "https://docs.example/install",
          },
        ],
      };
      const id = await store.learnerCreateIssue(input);
      assert.ok(id);
      assert.equal(await store.learnerCreateIssue(input), null);
      const issue = await store.learnerIssue(id);
      const itemId = issue!.items[0]!.id;
      assert.equal(await store.learnerItemUrl(itemId), null);

      assert.equal(
        await store.learnerDecideIssue(id, "sending", "owner"),
        true,
      );
      assert.equal(
        await store.learnerDecideIssue(id, "sending", "owner"),
        false,
      );
      assert.equal(
        await store.learnerDecideIssue(id, "skipped", "owner"),
        false,
      );
      await store.learnerRecordDelivery({
        issueId: id,
        userId: "u1",
        state: "sent",
      });
      await store.learnerRecordDelivery({
        issueId: id,
        userId: "u1",
        state: "failed",
      });
      await store.learnerFinishIssue(id);
      assert.deepEqual(await store.learnerDeliveryCounts(id), {
        sent: 1,
        failed: 0,
      });
      assert.equal(
        await store.learnerItemUrl(itemId),
        "https://docs.example/install",
      );
      await store.learnerRecordClick(itemId, "u1");

      assert.equal(await store.learnerOptOut("u2"), true);
      assert.equal(await store.learnerOptOut("u2"), false);
      assert.equal(await store.learnerSetEmailInterest("u1", true), true);
      assert.equal(await store.learnerReportClaim("2026-10-26"), true);
      assert.equal(await store.learnerReportClaim("2026-10-26"), false);

      const data = await store.learnerReportData(
        new Date(Date.now() - 86_400_000),
        new Date(Date.now() + 86_400_000),
      );
      assert.equal(data.active, 1);
      assert.equal(data.optOutsTotal, 1);
      assert.equal(data.clickers, 1);
      assert.equal(data.repliesTotal, 1);
      assert.equal(data.emailYes, 1);
    } finally {
      await store.close();
    }
  });
});
