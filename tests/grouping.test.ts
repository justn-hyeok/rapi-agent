import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubRepositoryInfo, repositoryContext } from "@rapi/adapters";
import {
  capItemsPerSource,
  renderBriefing,
  repositoryKey,
  type BriefingItem,
} from "@rapi/core";

test("extracts owner/repo from github.com URLs only", () => {
  assert.equal(repositoryKey("https://github.com/a/b/pull/3"), "a/b");
  assert.equal(repositoryKey("https://github.com/a/b.git"), "a/b");
  assert.equal(repositoryKey("https://github.com/a/b"), "a/b");
  assert.equal(repositoryKey("https://github.com/settings/tokens"), null);
  assert.equal(repositoryKey("https://github.com/a"), null);
  assert.equal(repositoryKey("https://github.blog/changelog/x/y"), null);
});

test("a repository group counts once toward source and batch limits", () => {
  const row = (id: string, source: string, group?: string) => ({
    id,
    source_id: source,
    group_key: group ?? null,
  });
  const rows = [
    row("g1", "gh", "a/b"),
    row("g2", "gh", "a/b"),
    row("g3", "gh", "c/d"),
    row("g4", "gh", "a/b"),
    row("g5", "gh", "e/f"),
    row("g6", "gh", "g/h"),
    row("n1", "news"),
  ];
  assert.deepEqual(
    capItemsPerSource(rows, 15).map((r) => r.id),
    ["g1", "g2", "g3", "g4", "g5", "n1"],
  );
  assert.deepEqual(
    capItemsPerSource(rows, 2).map((r) => r.id),
    ["g1", "g2", "g3", "g4"],
  );
});

test("renders one entry per repository group", () => {
  const item = (
    id: string,
    groupKey: string | null,
    summary: string,
  ): BriefingItem => ({
    id,
    title: `title ${id}`,
    canonicalUrl: `https://github.com/${groupKey ?? "x/y"}/pull/${id}`,
    summary,
    categories: [],
    visibility: "private",
    groupKey,
  });
  const payload = renderBriefing("B", [
    item("1", "a/b", "묶음 요약"),
    item("2", null, "단독"),
    item("3", "a/b", "묶음 요약"),
  ]);
  assert.match(
    payload.text,
    /a\/b · GitHub 활동 2건\n {2}묶음 요약\n {2}https:\/\/github.com\/a\/b\n/,
  );
  assert.equal(payload.text.match(/묶음 요약/g)?.length, 1);
  assert.deepEqual(payload.itemIds, ["1", "2", "3"]);
});

test("repository info is cached and failures become null", async () => {
  let calls = 0;
  const info = new GitHubRepositoryInfo(undefined, {}, async (path) => {
    calls += 1;
    if (path === "repos/x/missing") throw new Error("404");
    return {
      full_name: "a/b",
      owner: { login: "a" },
      description: "Agent harness",
      stargazers_count: 1200,
      topics: ["mcp"],
    };
  });
  const first = await info.describe("a/b");
  await info.describe("A/B");
  assert.equal(calls, 1);
  assert.equal(
    repositoryContext(first!),
    "GitHub 저장소 a/b: Agent harness · ★1200 · topics: mcp",
  );
  assert.equal(await info.describe("x/missing"), null);
});
