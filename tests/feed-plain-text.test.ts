import assert from "node:assert/strict";
import test from "node:test";
import { CommunityFeeds } from "../packages/agent/src/community-feeds.js";

test("AI blog cards show feed text without markup or entities", async () => {
  const drafts: Array<{ embeds: Array<Record<string, unknown>> }> = [];
  const store = {
    communityPostExists: async () => false,
    officialItems: async () => [
      {
        id: "1",
        source: "Example",
        title: "It&#8217;s <b>new</b>",
        url: "https://example.com/a",
        summary: "<p>Intro &lt;img src=x&gt; text</p>",
      },
    ],
    citationCandidates: async () => [],
    saveCommunityDraft: async (draft: {
      embeds: Array<Record<string, unknown>>;
    }) => {
      drafts.push(draft);
    },
  };
  const feeds = new CommunityFeeds(store as never, undefined, {
    guildId: "g",
    owner: "o",
    post: async () => "m",
  });
  await feeds.aiBlogs(new Date("2026-10-27T01:00:00Z"));
  const embed = drafts[0]!.embeds[0]!;
  assert.equal(embed.title, "Example · It’s new");
  assert.equal(embed.description, "Intro text");
});
