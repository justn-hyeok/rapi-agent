import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CommunityFeeds,
  RapiAgent,
  RecordingDeliveryAdapter,
  RecordingOmpAdapter,
} from "@rapi/agent";
import { PostgresStore } from "@rapi/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Curation E2E requires rapi_test");

describe("curation feeds", () => {
  it("posts each feed once to its managed channel and skips missing channels", async () => {
    const store = new PostgresStore(databaseUrl);
    const agent = new RapiAgent(
      store,
      new RecordingDeliveryAdapter(),
      new RecordingOmpAdapter(),
    );
    try {
      await store.resetForTests();
      await store.pool.query("DELETE FROM community_posts");
      await store.pool.query(
        "DELETE FROM discord_managed_resources WHERE guild_id='g'",
      );
      const posts: Array<{
        channel: string;
        embeds: Array<Record<string, unknown>>;
      }> = [];
      const setupFile = join(
        await mkdtemp(join(tmpdir(), "rapi-setup-")),
        "setup.md",
      );
      await writeFile(setupFile, "# 세팅\n\n- Herdr\n- Codex\n");
      let models = [
        { id: "a:free", name: "A", pricing: { prompt: "0", completion: "0" } },
        { id: "paid", pricing: { prompt: "1", completion: "1" } },
      ];
      const feeds = new CommunityFeeds(
        store,
        {
          policy: "t",
          summarize: async (items) =>
            new Map(items.map((i) => [i.id, `요약 ${i.title}`])),
          detail: async () => ["핵심"],
        },
        {
          guildId: "g",
          owner: "me",
          setupFile,
          autoPost: { "ai-blogs": true, "free-tokens": true },
          post: async (channel, embeds) => {
            posts.push({ channel, embeds });
            return String(posts.length);
          },
          getText: async () => "README",
          getJson: async (url) => {
            if (url.includes("openrouter")) return { data: models };
            if (url.includes("/users/me/repos"))
              return [
                {
                  name: "brgr",
                  full_name: "me/brgr",
                  html_url: "https://github.com/me/brgr",
                  description: "Agent runner",
                  fork: false,
                  archived: false,
                  private: false,
                  pushed_at: new Date().toISOString(),
                  stargazers_count: 3,
                  language: "Rust",
                },
              ];
            if (url.includes("/releases"))
              return [
                {
                  tag_name: "v1.0.0",
                  name: "v1.0.0",
                  html_url: "https://github.com/me/brgr/releases/v1.0.0",
                  body: "First release",
                  published_at: new Date().toISOString(),
                  draft: false,
                },
              ];
            return [];
          },
        },
      );
      const now = new Date();
      // No channels yet: nothing is posted, but free models are remembered.
      await feeds.runOnce(now);
      assert.equal(posts.length, 0);

      for (const [key, id] of [
        ["curation_projects", "c-proj"],
        ["curation_setup", "c-setup"],
        ["curation_ai_blogs", "c-ai"],
        ["curation_free_tokens", "c-free"],
      ])
        await store.pool.query(
          "INSERT INTO discord_managed_resources(guild_id,resource_type,resource_key,discord_id,last_applied_digest) VALUES('g','channel',$1,$2,'test')",
          [key, id],
        );
      await store.pool.query("DELETE FROM community_posts");
      const source = await agent.createSource(
        "rss",
        "https://official.example/feed",
        "public",
      );
      await store.pool.query(
        `UPDATE sources SET collection_policy=collection_policy||'{"official":"true","label":"Official"}'::jsonb WHERE id=$1`,
        [source],
      );
      const hn = await agent.createSource(
        "rss",
        "https://hn.example/feed",
        "public",
      );
      await agent.ingestExternalItem(
        source,
        {
          externalId: "o1",
          url: "https://official.example/post",
          title: "Big launch",
          body: "Launch body",
          author: null,
          publishedAt: now.toISOString(),
          metadata: {},
        },
        now,
      );
      await agent.ingestExternalItem(
        hn,
        {
          externalId: "h1",
          url: "https://official.example/post",
          title: "Big launch (discussion)",
          body: "",
          author: null,
          publishedAt: now.toISOString(),
          metadata: {},
        },
        now,
      );
      await agent.ingestExternalItem(
        hn,
        {
          externalId: "h2",
          url: "https://x.example/credits",
          title: "Vendor gives free credits to students",
          body: "",
          author: null,
          publishedAt: now.toISOString(),
          metadata: {},
        },
        now,
      );

      const morning = new Date(new Date().setUTCHours(1, 0, 0, 0)); // 10:00 KST
      await feeds.runOnce(morning);
      const byChannel = (id: string) => posts.filter((p) => p.channel === id);
      // Reviewed feeds wait as drafts; automatic feeds are posted.
      assert.equal(byChannel("c-setup").length, 0);
      assert.equal(byChannel("c-proj").length, 0);
      const drafts = await feeds.drafts();
      assert.deepEqual(drafts.map((d) => d.label).sort(), [
        "세팅 소개",
        "프로젝트 소식",
        "프로젝트 소식",
      ]);
      assert.equal(byChannel("c-ai").length, 1);
      assert.match(
        JSON.stringify(byChannel("c-ai")[0]!.embeds),
        /이 글을 다룬 곳 1/,
      );
      assert.equal(byChannel("c-free").length, 2);
      assert.match(JSON.stringify(byChannel("c-free")), /지금 무료인 모델 1개/);

      const intro = drafts.find((d) => d.title.includes("새 프로젝트 · brgr"))!;
      assert.deepEqual(await feeds.sendDraft(intro.key), {
        ok: true,
        message: "채널에 보냈습니다.",
      });
      assert.equal(byChannel("c-proj").length, 1);
      assert.equal((await feeds.sendDraft(intro.key)).ok, false);
      const setup = drafts.find((d) => d.label === "세팅 소개")!;
      assert.equal((await feeds.discardDraft(setup.key)).ok, true);
      assert.equal((await feeds.drafts()).length, 1);
      await feeds.runOnce(morning);
      assert.equal((await feeds.drafts()).length, 1); // discarded and sent drafts never return

      const before = posts.length;
      models = [
        ...models,
        { id: "b:free", name: "B", pricing: { prompt: "0", completion: "0" } },
      ];
      await store.pool.query(
        "DELETE FROM community_posts WHERE starts_with(key,'free-models:') OR starts_with(key,'projects:check:')",
      );
      await feeds.runOnce(morning);
      const fresh = posts.slice(before);
      assert.equal(fresh.length, 1);
      assert.match(JSON.stringify(fresh[0]!.embeds), /새 무료 모델 1개/);
    } finally {
      await store.close();
    }
  });
});
