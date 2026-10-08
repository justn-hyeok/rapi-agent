import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDetail } from "@rapi/adapters";
import {
  learnPreferences,
  preferenceScore,
  rankByPreference,
  titleTerms,
} from "@rapi/core";

test("title terms drop stopwords, numbers and short words", () => {
  assert.deepEqual(titleTerms("Show HN: MCP servers for Claude Code 2026"), [
    "mcp",
    "servers",
    "claude",
    "code",
  ]);
  assert.deepEqual(titleTerms("개발자 현황과 AI 에이전트"), [
    "개발자",
    "현황과",
    "에이전트",
  ]);
});

test("reactions shape source and term weights and explain the boost", () => {
  const preferences = learnPreferences([
    { sourceId: "hn", title: "New MCP server for agents", kind: "up" },
    { sourceId: "hn", title: "MCP tooling deep dive", kind: "save" },
    { sourceId: "geek", title: "Crypto market weekly", kind: "down" },
  ]);
  const liked = preferenceScore(
    { sourceId: "lobsters", title: "Building an MCP gateway" },
    preferences,
  );
  assert.ok(liked.score > 0);
  assert.equal(liked.reason, "좋아요 누른 'mcp' 관련");
  const disliked = preferenceScore(
    { sourceId: "geek", title: "Crypto prices" },
    preferences,
  );
  assert.ok(disliked.score < 0);
  assert.equal(disliked.reason, undefined);
});

test("ranking lifts preferred items while keeping recency as a tiebreaker", () => {
  const preferences = learnPreferences([
    { sourceId: "b", title: "rust compiler internals", kind: "save" },
  ]);
  const rows = [
    { id: 1, source: "a", title: "frontend news" },
    { id: 2, source: "a", title: "design weekly" },
    { id: 3, source: "b", title: "rust compiler release" },
  ];
  assert.deepEqual(
    rankByPreference(rows, preferences, (r) => ({
      sourceId: r.source,
      title: r.title,
    })).map((r) => r.id),
    [3, 1, 2],
  );
  assert.deepEqual(
    rankByPreference(rows, learnPreferences([]), (r) => ({
      sourceId: r.source,
      title: r.title,
    })).map((r) => r.id),
    [1, 2, 3],
  );
});

test("detail points are bounded strings", () => {
  assert.deepEqual(
    parseDetail(
      JSON.stringify({
        points: ["  a  ", 3, "", "x".repeat(200), "b", "c", "d", "e", "f"],
      }),
    ).map((p) => p.length),
    [1, 160, 1, 1, 1, 1],
  );
});
