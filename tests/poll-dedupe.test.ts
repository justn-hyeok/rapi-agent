import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { FeedSourceAdapter, HtmlSourceAdapter } from "@rapi/adapters";
import { RapiAgent, RecordingDeliveryAdapter } from "@rapi/agent";
import { GitHubSourceAdapter } from "@rapi/adapters";
import type { PostgresStore } from "@rapi/db";

// In-memory store with the same uniqueness rules as the raw_events indexes:
// (source_id, external_event_id) and, without an id, (source_id, payload hash).
function fakeStore(
  sources: Array<{
    id: string;
    kind: string;
    locator: string;
    policy?: object;
  }>,
) {
  const rawEvents = new Map<
    string,
    { id: string; externalId: string | null }
  >();
  const items = new Set<string>();
  const failures: string[] = [];
  const store = {
    async collectableSources() {
      return sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        locator: source.locator,
        collection_policy: source.policy ?? {},
        etag: null,
        last_success_at: null,
      }));
    },
    async insertRawEvent(
      sourceId: string,
      externalId: string | null,
      checksum: string,
    ) {
      const key = `${sourceId}:${externalId ?? `hash:${checksum}`}`;
      const existing = rawEvents.get(key);
      if (existing) return { id: existing.id, inserted: false };
      const id = `raw-${rawEvents.size + 1}`;
      rawEvents.set(key, { id, externalId });
      return { id, inserted: true };
    },
    async sourceVisibility() {
      return "public";
    },
    async saveItem(item: { rawEventId: string }) {
      const inserted = !items.has(item.rawEventId);
      items.add(item.rawEventId);
      return { id: `item-${item.rawEventId}`, inserted };
    },
    async saveCursor() {},
    async recordSourceFailure(_id: string, message: string) {
      failures.push(message);
    },
  };
  return {
    store: store as unknown as PostgresStore,
    rawEvents,
    items,
    failures,
  };
}

const feed = (
  build: number,
) => `<?xml version="1.0"?><rss version="2.0"><channel>
<lastBuildDate>build ${build}</lastBuildDate>
<item><guid>a</guid><title>First</title><link>https://example.com/a</link><description>A</description></item>
<item><guid>b</guid><title>Second</title><link>https://example.com/b</link><description>B</description></item>
</channel></rss>`;

test("polling an unchanged feed twice stores its items once and no per-poll snapshot", async () => {
  let polls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/list") {
      res.end(
        `<html><body><a href="/news/one">One</a><!-- ${polls++} --></body></html>`,
      );
      return;
    }
    // The body differs on every poll, like a feed that embeds a build time.
    res.end(feed(polls++));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const { store, rawEvents, items, failures } = fakeStore([
      { id: "s-rss", kind: "rss", locator: `${base}/feed` },
      {
        id: "s-html",
        kind: "html",
        locator: `${base}/list`,
        policy: { html: { linkPattern: "^/news/[a-z]+$" } },
      },
    ]);
    const agent = new RapiAgent(store, new RecordingDeliveryAdapter());
    const inserted: string[] = [];
    for (let poll = 0; poll < 2; poll += 1)
      await agent.collectConfiguredSources(
        new FeedSourceAdapter(),
        new GitHubSourceAdapter(),
        async (input) => {
          inserted.push(input.itemId);
        },
        undefined,
        new HtmlSourceAdapter(),
      );
    assert.deepEqual(failures, []);
    assert.equal(rawEvents.size, 3, "two rss items and one html item");
    assert.ok([...rawEvents.values()].every((raw) => raw.externalId));
    assert.equal(items.size, 3);
    // Only the first poll announces items.
    assert.equal(inserted.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a response that fails to parse is still kept for diagnosis", async () => {
  const server = createServer((_req, res) => res.end("not a feed"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const { store, rawEvents, failures } = fakeStore([
      {
        id: "s-bad",
        kind: "rss",
        locator: `http://127.0.0.1:${address.port}/feed`,
      },
    ]);
    const agent = new RapiAgent(store, new RecordingDeliveryAdapter());
    await agent.collectConfiguredSources(
      new FeedSourceAdapter(),
      new GitHubSourceAdapter(),
    );
    assert.equal(failures.length, 1);
    assert.equal(rawEvents.size, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
