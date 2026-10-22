import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { PostgresStore } from "@rapi/db";

const run = promisify(execFile);
const key = Buffer.alloc(32, 7).toString("hex");

it("counts only public publications as links requiring withdrawal", async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const store = new PostgresStore(process.env.DATABASE_URL!, {
    privacyHmacKey: key,
  });
  try {
    await store.resetForTests();
    const collected = new Date(Date.now() - 120 * 86_400_000);
    for (const visibility of ["public", "private"] as const) {
      const source = await store.createSource(
        "rss",
        `https://report.example/${randomUUID()}`,
        visibility,
      );
      const raw = await store.insertRawEvent(
        source,
        "event-1",
        "checksum",
        { body: "body" },
        collected,
      );
      const item = await store.saveItem(
        {
          id: randomUUID(),
          rawEventId: raw.id,
          sourceId: source,
          normalizerVersion: "test-v1",
          canonicalUrl: "https://report.example/item",
          title: "title",
          body: "body",
          author: null,
          publishedAt: null,
          collectedAt: collected,
          visibility,
          contentFingerprint: randomUUID(),
          metadata: {},
          categories: [],
        },
        "summary",
      );
      const sub = randomUUID();
      const batch = randomUUID();
      await client.query(
        "INSERT INTO subscriptions(id,owner_id,name,cadence,channels) VALUES($1::uuid,'10000000000000001',$1::text,'weekly','[]')",
        [sub],
      );
      await client.query(
        "INSERT INTO delivery_batches(id,subscription_id,period_start,period_end,renderer_version,state) VALUES($1,$2,now()-interval '7 days',now(),'v1','delivered')",
        [batch, sub],
      );
      await client.query(
        "INSERT INTO delivery_batch_items(batch_id,source_item_id,position) VALUES($1,$2,0)",
        [batch, item.id],
      );
      await store.recordPublication(
        batch,
        visibility,
        `/tmp/report-${visibility}-${randomUUID()}.mdx`,
        "hash",
      );
    }
    const { stdout } = await run(process.execPath, [
      "scripts/retention-report.mjs",
    ]);
    const report = JSON.parse(stdout) as {
      candidates: { publication_links_requiring_withdrawal: number };
    };
    assert.equal(report.candidates.publication_links_requiring_withdrawal, 1);
  } finally {
    await store.close();
    await client.end();
  }
});
