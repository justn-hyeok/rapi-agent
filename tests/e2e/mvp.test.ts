import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MdxPublisher } from "@rapi/adapters";
import {
  DiscordCommandService,
  RapiAgent,
  RecordingDeliveryAdapter,
  RecordingOmpAdapter,
} from "@rapi/agent";
import { PostgresStore } from "@rapi/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("MVP E2E requires rapi_test");

const rssFixture = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Rapi Feed</title><item>
  <guid>feed-1</guid><title>AI security release</title>
  <link>https://example.com/posts/release?b=2&amp;a=1</link>
  <description>A model security release with practical details.</description>
  <author>feed@example.com</author><pubDate>Tue, 08 Sep 2026 00:10:00 GMT</pubDate>
</item></channel></rss>`;

const githubFixture = {
  id: "github-1",
  type: "PullRequestEvent",
  html_url: "https://github.com/example/rapi/pull/1",
  title: "Release ingestion worker",
  body: "Pull request adds a durable GitHub ingestion worker.",
  user: { login: "octocat" },
  repository: { full_name: "example/rapi" },
  created_at: "2026-09-08T00:20:00Z",
};

describe("rapi-agent MVP", () => {
  it("passes all eight product completion scenarios", async () => {
    const store = new PostgresStore(databaseUrl);
    const delivery = new RecordingDeliveryAdapter();
    const omp = new RecordingOmpAdapter();
    const agent = new RapiAgent(store, delivery, omp);
    const outputRoot = `/tmp/rapi-e2e-${randomUUID()}`;
    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(outputRoot, { recursive: true });

    try {
      await store.resetForTests();
      await store.enableChatChannel("guild-1", "channel-1", "owner-1");
      assert.equal(
        await store.chatChannelEnabled("guild-1", "channel-1"),
        true,
      );
      assert.equal(
        await store.appendChatMessage({
          guildId: "guild-1",
          channelId: "channel-1",
          discordMessageId: "chat-message-1",
          authorId: "owner-1",
          role: "user",
          content: "서버 상태 알려줘",
        }),
        true,
      );
      assert.equal(
        await store.appendChatMessage({
          guildId: "guild-1",
          channelId: "channel-1",
          discordMessageId: "chat-message-1",
          authorId: "owner-1",
          role: "user",
          content: "중복 메시지",
        }),
        false,
      );
      assert.deepEqual(await store.recentChatMessages("channel-1"), [
        { role: "user", content: "서버 상태 알려줘" },
      ]);
      assert.equal(await store.disableChatChannel("channel-1"), true);
      assert.equal(
        await store.chatChannelEnabled("guild-1", "channel-1"),
        false,
      );
      const githubSource = await agent.createSource(
        "github",
        "example/rapi",
        "public",
      );
      const rssSource = await agent.createSource(
        "rss",
        "https://example.com/feed.xml",
        "public",
      );
      const failingSource = await agent.createSource(
        "rss",
        "https://invalid.example/feed.xml",
        "public",
      );

      assert.equal(
        await agent.ingestGitHub(
          githubSource,
          [githubFixture],
          new Date("2026-09-08T01:00:00Z"),
        ),
        1,
      );
      assert.equal(
        await agent.ingestFeed(
          rssSource,
          rssFixture,
          new Date("2026-09-08T01:00:00Z"),
        ),
        1,
      );
      assert.equal(
        await agent.ingestGitHub(
          githubSource,
          [githubFixture],
          new Date("2026-09-08T01:01:00Z"),
        ),
        0,
      );
      assert.equal(
        await agent.ingestFeed(
          rssSource,
          rssFixture,
          new Date("2026-09-08T01:01:00Z"),
        ),
        0,
      );

      const counts = await store.pool.query<{ raw: string; items: string }>(
        "SELECT (SELECT count(*) FROM raw_events) AS raw,(SELECT count(*) FROM source_items) AS items",
      );
      assert.deepEqual(counts.rows[0], { raw: "2", items: "2" });

      let successfulIndependentCollection = false;
      await agent.collectIndependently([
        {
          sourceId: failingSource,
          collect: () => Promise.reject(new Error("fixture unavailable")),
        },
        {
          sourceId: rssSource,
          collect: () => {
            successfulIndependentCollection = true;
            return Promise.resolve();
          },
        },
      ]);
      assert.equal(successfulIndependentCollection, true);
      assert.equal((await store.getCursor(failingSource))?.failureCount, 1);

      const commands = new DiscordCommandService(agent, {
        userIds: ["owner-1"],
        guildIds: ["guild-1"],
        channelIds: ["channel-1"],
      });
      const subscribe = await commands.execute(
        { userId: "owner-1", guildId: "guild-1", channelId: "channel-1" },
        {
          name: "subscribe",
          options: {
            subscription: {
              ownerId: "owner-1",
              name: "daily",
              sourceIds: [githubSource, rssSource],
              categories: [],
              includeKeywords: [],
              excludeKeywords: [],
              cadence: "daily",
              timezone: "UTC",
              maxItems: 20,
              channels: [
                { channel: "discord_dm", recipientId: "owner-1" },
                { channel: "email", recipientId: "test@example.com" },
              ],
            },
          },
        },
      );
      const subscriptionId = String(subscribe.data?.subscriptionId);
      delivery.failRecipients.add("test@example.com");
      const brief = await commands.execute(
        { userId: "owner-1", guildId: "guild-1", channelId: "channel-1" },
        {
          name: "brief",
          options: {
            subscriptionId,
            periodStart: "2026-09-08T00:00:00Z",
            periodEnd: "2026-09-09T00:00:00Z",
          },
        },
      );
      const batchId = String(brief.data?.batchId);
      assert.equal(brief.data?.state, "partially_failed");
      assert.equal(delivery.messages.length, 1);
      delivery.failRecipients.delete("test@example.com");
      assert.equal(await agent.deliverBatch(batchId), "delivered");
      assert.equal(delivery.messages.length, 2);
      assert.deepEqual(
        delivery.messages[0]!.payload.itemIds,
        delivery.messages[1]!.payload.itemIds,
      );
      assert.match(delivery.messages[1]!.payload.text, /https:\/\//);
      assert.match(delivery.messages[1]!.payload.html, /<a href=/);

      const publisher = new MdxPublisher(
        join(outputRoot, "content"),
        join(outputRoot, "public"),
      );
      const publicPath = await agent.publishBatch(
        batchId,
        "public",
        "daily-2026-09-08",
        publisher,
        new Date("2026-09-08T02:00:00Z"),
      );
      assert.match(await readFile(publicPath, "utf8"), /visibility: public/);
      await publisher.publish(
        "private-note",
        "---\ntitle: Private\nvisibility: private\n---\nsecret",
      );
      const built = await publisher.buildPublic();
      assert.equal(built.length, 1);
      assert.match(await readFile(built[0]!, "utf8"), /daily briefing/);

      const privateSource = await agent.createSource(
        "aside",
        "approved-browser-session",
        "private",
      );
      await agent.ingestExternalItem(
        privateSource,
        {
          externalId: "aside-1",
          url: "https://private.example/item",
          title: "Private research",
          body: "Information from an authenticated browser session.",
          author: null,
          publishedAt: "2026-09-08T00:30:00Z",
          metadata: { session: "private" },
        },
        new Date("2026-09-08T01:00:00Z"),
      );
      const privateSubscription = await agent.createSubscription({
        ownerId: "owner-1",
        name: "private",
        sourceIds: [privateSource],
        categories: [],
        includeKeywords: [],
        excludeKeywords: [],
        cadence: "daily",
        timezone: "UTC",
        channels: [{ channel: "discord_dm", recipientId: "owner-1" }],
        maxItems: 20,
      });
      const privateBatch = await agent.freezeBatch(
        privateSubscription,
        new Date("2026-09-08T00:00:00Z"),
        new Date("2026-09-09T00:00:00Z"),
      );
      await assert.rejects(
        agent.publishBatch(
          privateBatch.id,
          "public",
          "private-leak",
          publisher,
        ),
        /cannot be included in a public publication/,
      );

      const taskResult = await commands.execute(
        { userId: "owner-1", guildId: "guild-1", channelId: "channel-1" },
        {
          name: "task",
          options: {
            specification: {
              goal: "Implement fixture",
              repository: "example/rapi",
              base_revision: "abc123",
              permissions: ["repo:write"],
              acceptance_criteria: ["tests pass"],
            },
          },
        },
      );
      const taskId = String(taskResult.data?.taskId);
      const approval = await commands.execute(
        { userId: "owner-1", guildId: "guild-1", channelId: "channel-1" },
        {
          name: "approve",
          options: {
            taskId,
            revision: 1,
            permissions: ["repo:write"],
            messageRef: "discord-message-1",
          },
        },
      );
      const attemptId = String(approval.data?.attemptId);
      const secondDispatch = await agent.dispatchTask(taskId);
      assert.equal(secondDispatch.attemptId, attemptId);
      assert.equal(omp.dispatches.length, 1);

      const revisionTask = await agent.createTask("owner-1", {
        goal: "Revision invalidation",
        permissions: ["repo:write"],
      });
      await agent.approveTask(
        revisionTask.taskId,
        1,
        "owner-1",
        ["repo:write"],
        "discord-message-2",
      );
      assert.equal(
        await store.reviseTask(revisionTask.taskId, {
          goal: "Changed revision",
          permissions: ["repo:write"],
        }),
        2,
      );
      await assert.rejects(
        agent.dispatchTask(revisionTask.taskId),
        /valid approval for the current revision is required/,
      );

      const callback = Buffer.from(
        JSON.stringify({
          callback_event_id: "callback-1",
          receipt_id: String(approval.data?.receiptId),
          execution_attempt_id: attemptId,
          state_version: 2,
          state: "completed",
          result_report_ref: "reports/result.md",
          evidence_refs: [
            "commit:deadbeef",
            "test:passed",
            "pr:https://github.com/example/rapi/pull/2",
          ],
        }),
      );
      const secret = "callback-test-secret";
      const signature = createHmac("sha256", secret)
        .update(callback)
        .digest("hex");
      assert.equal(
        await agent.receiveOmpCallback(callback, signature, secret),
        true,
      );
      assert.equal(await store.taskState(taskId), "completed");
      assert.match(delivery.messages.at(-1)!.payload.text, /completed/);
      assert.equal(
        await agent.receiveOmpCallback(callback, signature, secret),
        false,
      );

      const simpleTask = await commands.execute(
        { userId: "owner-1", guildId: "guild-1", channelId: "channel-1" },
        {
          name: "task",
          options: { content: "한글로 간단한 작업을 수행한다" },
        },
      );
      assert.match(simpleTask.messages[0]!, /\/승인/);
      const simpleApproval = await commands.execute(
        { userId: "owner-1", guildId: "guild-1", channelId: "channel-1" },
        { name: "approve", options: {} },
      );
      assert.match(simpleApproval.messages[0]!, /OMP에 전달/);
      assert.equal(
        omp.dispatches.at(-1)?.specification.goal,
        "한글로 간단한 작업을 수행한다",
      );
      assert.equal(
        omp.dispatches.at(-1)?.specification.model,
        "gpt-5.3-codex-spark",
      );

      const astraTask = await commands.execute(
        { userId: "owner-1", guildId: "guild-1", channelId: "channel-1" },
        {
          name: "task",
          options: { content: "오류를 고친다", model: "아스트라" },
        },
      );
      await commands.execute(
        { userId: "owner-1", guildId: "guild-1", channelId: "channel-1" },
        { name: "approve", options: { taskId: astraTask.data?.taskId } },
      );
      assert.equal(omp.dispatches.at(-1)?.specification.model, "gpt-6-astra");

      await assert.rejects(
        commands.execute(
          { userId: "intruder", guildId: "guild-1", channelId: "channel-1" },
          { name: "sources", options: {} },
        ),
        /user is not allowed/,
      );
      await assert.rejects(
        commands.execute(
          { userId: "owner-1", guildId: "wrong", channelId: "channel-1" },
          {
            name: "approve",
            options: { taskId, revision: 1, permissions: [], messageRef: "x" },
          },
        ),
        /guild is not allowed/,
      );
      await assert.rejects(
        commands.execute(
          { userId: "owner-1", guildId: "guild-1", channelId: "wrong" },
          { name: "sources", options: {} },
        ),
        /channel is not allowed/,
      );

      const cursorBeforeRestart = await store.getCursor(rssSource);
      await store.close();
      const restartedStore = new PostgresStore(databaseUrl);
      const restartedAgent = new RapiAgent(restartedStore, delivery, omp);
      assert.deepEqual(
        await restartedStore.getCursor(rssSource),
        cursorBeforeRestart,
      );
      assert.equal(await restartedAgent.deliverBatch(batchId), "delivered");
      assert.equal(
        delivery.messages.filter(
          (message) => message.payload.itemIds.length > 0,
        ).length,
        2,
      );

      await mkdir("tests/artifacts", { recursive: true });
      await writeFile(
        "tests/artifacts/mvp-e2e.json",
        JSON.stringify(
          {
            passedAt: new Date().toISOString(),
            scenarios: 8,
            ingestionFixtureRawEvents: 2,
            totalRawEvents: 3,
            ingestionFixtureSourceItems: 2,
            totalSourceItems: 3,
            batchId,
            taskId,
            databaseRestartSafe: true,
          },
          null,
          2,
        ),
      );
      await restartedStore.close();
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
