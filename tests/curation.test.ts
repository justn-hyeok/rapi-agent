import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findCitations,
  isFreeTokenNews,
  kstDateKey,
  kstReached,
  kstWeekday,
  selectProjectRepositories,
} from "@rapi/core";

test("KST calendar helpers", () => {
  const now = new Date("2026-10-11T23:30:00Z"); // Mon 08:30 KST
  assert.equal(kstDateKey(now), "2026-10-12");
  assert.equal(kstWeekday(now), 1);
  assert.equal(kstReached(now, 8, 30), true);
  assert.equal(kstReached(now, 9), false);
});

test("citations match links, linking bodies and quoted titles", () => {
  const official = {
    id: "o",
    url: "https://www.anthropic.com/news/claude-code-2?utm_source=x",
    title: "Introducing Claude Code 2 for teams",
  };
  const others = [
    {
      id: "a",
      url: "https://anthropic.com/news/claude-code-2",
      title: "HN thread",
      body: "",
      source: "HN",
    },
    {
      id: "b",
      url: "https://simonwillison.net/x",
      title: "Notes",
      body: "I tried https://www.anthropic.com/news/claude-code-2 today",
      source: "Simon",
    },
    {
      id: "c",
      url: "https://news.hada.io/1",
      title: "Introducing Claude Code 2 for teams 요약",
      body: "",
      source: "GeekNews",
    },
    {
      id: "d",
      url: "https://example.com/other",
      title: "Unrelated",
      body: "anthropic.com/news/other",
      source: "X",
    },
    {
      id: "o",
      url: official.url,
      title: official.title,
      body: "",
      source: "Anthropic",
    },
  ];
  assert.deepEqual(
    findCitations(official, others).map((c) => c.id),
    ["a", "b", "c"],
  );
});

test("free token news detection", () => {
  assert.ok(isFreeTokenNews("Gemini API free tier now includes 2.5 Pro", ""));
  assert.ok(isFreeTokenNews("Groq gives $50 free credits", ""));
  assert.ok(isFreeTokenNews("새 모델 무료 공개", ""));
  assert.ok(
    isFreeTokenNews("Startup program", "Apply for free API access this month"),
  );
  assert.ok(!isFreeTokenNews("Free software foundation news", "freedom"));
  assert.ok(!isFreeTokenNews("Rust 1.90 released", ""));
});

test("project selection keeps recent public originals", () => {
  const now = new Date("2026-10-09T00:00:00Z");
  const repo = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    fork: false,
    archived: false,
    private: false,
    pushedAt: "2026-10-01T00:00:00Z",
    ...extra,
  });
  assert.deepEqual(
    selectProjectRepositories(
      [
        repo("brgr"),
        repo("justn-hyeok"),
        repo("test"),
        repo("forked", { fork: true }),
        repo("old", { pushedAt: "2025-01-01T00:00:00Z" }),
        repo("secret", { private: true }),
      ],
      "justn-hyeok",
      now,
    ).map((r) => r.name),
    ["brgr"],
  );
});
