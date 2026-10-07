import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubStarRecommender,
  rankStarRecommendations,
  type StarredRepository,
} from "@rapi/adapters";
import { capItemsPerSource } from "@rapi/core";

const now = new Date("2026-10-07T00:00:00Z");
const recent = "2026-10-05T00:00:00Z";
const repo = (
  fullName: string,
  extra: Partial<StarredRepository> = {},
): StarredRepository => ({
  fullName,
  owner: fullName.split("/")[0]!,
  description: "",
  stars: 100,
  topics: [],
  starredAt: recent,
  fork: false,
  archived: false,
  ...extra,
});

test("ranks repositories that several taste neighbors recently starred", () => {
  const items = rankStarRecommendations({
    user: "me",
    mine: [repo("a/one", { topics: ["mcp", "codex"] })],
    neighbors: [
      { login: "n1", starred: [repo("x/shared"), repo("y/single")] },
      { login: "n2", starred: [repo("x/shared")] },
    ],
    topicCandidates: [],
    exclude: new Set(),
    now,
    limit: 5,
  });
  assert.deepEqual(
    items.map((item) => item.externalId),
    ["x/shared"],
  );
  assert.match(items[0]!.body, /최근 star: n1, n2/);
  assert.equal(items[0]!.url, "https://github.com/x/shared");
});

test("excludes starred, own, shown, stale, huge, fork and self-owned repos", () => {
  const both = (r: StarredRepository) => [
    { login: "n1", starred: [r] },
    { login: "n2", starred: [r] },
  ];
  const cases = [
    repo("a/one"),
    repo("me/mine"),
    repo("x/shown"),
    repo("x/stale", { starredAt: "2026-09-01T00:00:00Z" }),
    repo("x/huge", { stars: 300_000 }),
    repo("x/fork", { fork: true }),
  ];
  for (const candidate of cases)
    assert.deepEqual(
      rankStarRecommendations({
        user: "me",
        mine: [repo("a/one")],
        neighbors: both(candidate),
        topicCandidates: [],
        exclude: new Set(["x/shown"]),
        now,
        limit: 5,
      }),
      [],
      candidate.fullName,
    );
  assert.deepEqual(
    rankStarRecommendations({
      user: "me",
      mine: [],
      neighbors: [
        { login: "x", starred: [repo("x/own")] },
        { login: "n2", starred: [repo("x/own")] },
      ],
      topicCandidates: [],
      exclude: new Set(),
      now,
      limit: 5,
    }).map((item) => item.metadata.neighbors),
    [],
  );
});

test("topic candidates need two interest topics", () => {
  const items = rankStarRecommendations({
    user: "me",
    mine: [repo("a/one", { topics: ["mcp", "codex", "cli"] })],
    neighbors: [],
    topicCandidates: [
      repo("t/strong", { topics: ["mcp", "codex"] }),
      repo("t/weak", { topics: ["mcp"] }),
    ],
    exclude: new Set(),
    now,
    limit: 5,
  });
  assert.deepEqual(
    items.map((item) => item.externalId),
    ["t/strong"],
  );
  assert.match(items[0]!.body, /관심 topic: mcp, codex/);
});

test("recommender tolerates neighbor and search failures", async () => {
  const recommender = new GitHubStarRecommender(undefined, {}, async (path) => {
    if (path.startsWith("users/me/starred"))
      return [
        {
          starred_at: recent,
          repo: {
            full_name: "n1/a",
            owner: { login: "n1" },
            stargazers_count: 5,
            topics: [],
          },
        },
        {
          starred_at: recent,
          repo: {
            full_name: "n2/b",
            owner: { login: "n2" },
            stargazers_count: 5,
            topics: [],
          },
        },
        {
          starred_at: recent,
          repo: {
            full_name: "n3/c",
            owner: { login: "n3" },
            stargazers_count: 5,
            topics: [],
          },
        },
      ];
    if (path.startsWith("users/n3/")) throw new Error("private stars");
    if (path.startsWith("users/n"))
      return [
        {
          starred_at: recent,
          repo: {
            full_name: "z/hit",
            owner: { login: "z" },
            stargazers_count: 50,
            topics: [],
          },
        },
      ];
    throw new Error(`unexpected ${path}`);
  });
  const items = await recommender.recommend("me", new Set(), 5, now);
  assert.deepEqual(
    items.map((item) => item.externalId),
    ["z/hit"],
  );
});

test("caps items per source while keeping rank order", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `g${i}`,
      source_id: "geek",
    })),
    { id: "r1", source_id: "rec", max_per_batch: "5" },
    { id: "o1", source_id: "openai" },
  ];
  assert.deepEqual(
    capItemsPerSource(rows, 15).map((row) => row.id),
    ["g0", "g1", "g2", "r1", "o1"],
  );
  assert.equal(capItemsPerSource(rows, 2).length, 2);
});
