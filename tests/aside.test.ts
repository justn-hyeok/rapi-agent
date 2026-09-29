import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  asideItems,
  asideSnapshotSchema,
} from "../packages/adapters/src/aside.js";
import { browserCode, parseBrowserOutput } from "../scripts/aside-browser.mjs";
import { assessSourceHealth } from "../workers/runtime/src/source-health.js";

const marker = "RAPI_ASIDE_0123456789abcdef0123456789abcdef:";
const snapshot = () => ({
  sourceId: randomUUID(),
  token: randomUUID(),
  adapter: "hacker-news-v1",
  pageUrl: "https://news.ycombinator.com/",
  collectedAt: new Date().toISOString(),
  stories: [
    {
      id: "123",
      title: "A story",
      articleUrl: "https://example.com/story",
      author: "reader",
    },
  ],
});

test("Aside validates snapshots and binds canonical URLs to the approved page", () => {
  const valid = asideSnapshotSchema.parse(snapshot());
  const [item] = asideItems(valid);
  assert.equal(item!.url, "https://news.ycombinator.com/item?id=123");
  assert.equal(item!.externalId, "hn:123");
  assert.equal(item!.metadata.adapter, "hacker-news-v1");
  for (const input of [
    { ...snapshot(), pageUrl: "https://other.example/" },
    { ...snapshot(), stories: [] },
    {
      ...snapshot(),
      stories: [
        { ...snapshot().stories[0], articleUrl: "javascript:alert(1)" },
      ],
    },
    {
      ...snapshot(),
      stories: [
        {
          ...snapshot().stories[0],
          articleUrl: "https://secret:token@example.com",
        },
      ],
    },
    { ...snapshot(), stories: [snapshot().stories[0], snapshot().stories[0]] },
  ])
    assert.equal(asideSnapshotSchema.safeParse(input).success, false);
});

test("Aside CLI exit 0 without a unique snapshot is not collection success", () => {
  assert.throws(() =>
    parseBrowserOutput("ReferenceError: page not found\n[error]", marker),
  );
  const value = snapshot();
  const output = marker + JSON.stringify(value);
  assert.throws(() => parseBrowserOutput(output + "\n" + output, marker));
  assert.deepEqual(
    parseBrowserOutput("[Aside status]\n" + output + "\n[ok]", marker),
    value,
  );
});

test("Aside program uses only an owned read-only tab and closes it", () => {
  const code = browserCode(marker);
  assert.ok(code.includes('openTab("https://news.ycombinator.com/")'));
  assert.ok(code.includes("finally { await p.close(); }"));
  assert.throws(() => browserCode("injected marker"));
});

test("an approved Aside bridge needs recent successful collection to report healthy", () => {
  const source = {
    kind: "aside",
    active: true,
    failureCount: 0,
    asideBridge: true,
  };
  assert.equal(assessSourceHealth([source]).status, "failed");
  assert.equal(
    assessSourceHealth([{ ...source, lastSuccessAt: new Date() }]).status,
    "ok",
  );
  assert.equal(
    assessSourceHealth([
      { ...source, lastSuccessAt: new Date(Date.now() - 31 * 60_000) },
    ]).status,
    "failed",
  );
  assert.equal(
    assessSourceHealth([{ ...source, lastSuccessAt: "invalid" }]).status,
    "failed",
  );
});
