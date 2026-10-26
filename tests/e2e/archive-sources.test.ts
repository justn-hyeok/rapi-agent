import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ChatbotStore, PostgresStore } from "@rapi/db";

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== "/rapi_test")
  throw new Error("Archive sources E2E requires rapi_test");

test("only public, live, distinct collected items reach the archive, and they leave when they stop qualifying", async () => {
  const db = new PostgresStore(url);
  const created = {
    sources: [] as string[],
    raws: [] as string[],
    items: [] as string[],
  };
  try {
    await db.pool.query("DELETE FROM archive_documents WHERE kind='source'");
    const addSource = async (state: string, policy: object) => {
      const id = randomUUID();
      await db.pool.query(
        "INSERT INTO sources(id,kind,locator,collection_policy,state) VALUES($1,'rss',$2,$3,$4)",
        [id, `https://feed.example/${id}`, JSON.stringify(policy), state],
      );
      created.sources.push(id);
      return id;
    };
    const addItem = async (
      sourceId: string,
      input: {
        title?: string;
        body?: string;
        link?: string;
        visibility?: string;
        daysAgo?: number;
        fingerprint?: string;
        metadata?: object;
      },
    ) => {
      const raw = randomUUID();
      const item = randomUUID();
      const at = new Date(Date.now() - (input.daysAgo ?? 1) * 86_400_000);
      await db.pool.query(
        "INSERT INTO raw_events(id,source_id,canonical_payload_hash,payload,collected_at) VALUES($1::uuid,$2,$1::text,'{}',$3)",
        [raw, sourceId, at],
      );
      await db.pool.query(
        `INSERT INTO source_items(id,raw_event_id,normalizer_version,canonical_url,title,body,collected_at,visibility,content_fingerprint,metadata)
         VALUES($1,$2,'t1',$3,$4,$5,$6,$7,$8,$9)`,
        [
          item,
          raw,
          input.link ?? `https://news.example/${item}`,
          input.title ?? `title ${item}`,
          input.body ?? "첫 줄 요약\n\n둘째   줄",
          at,
          input.visibility ?? "public",
          input.fingerprint ?? item,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      created.raws.push(raw);
      created.items.push(item);
      return item;
    };

    const publicSource = await addSource("active", {});
    const explicitPublic = await addSource("active", { visibility: "public" });
    const privateSource = await addSource("active", { visibility: "private" });
    const pausedSource = await addSource("paused", {});

    const good = await addItem(publicSource, { title: "  좋은 글  " });
    const good2 = await addItem(explicitPublic, {});
    await addItem(publicSource, { visibility: "private" });
    await addItem(privateSource, {});
    await addItem(pausedSource, {});
    await addItem(publicSource, { link: "http://insecure.example/x" });
    await addItem(publicSource, { daysAgo: 120 });
    await addItem(publicSource, { metadata: { retentionExpired: "true" } });
    await addItem(publicSource, { title: "   " });
    const first = await addItem(publicSource, {
      fingerprint: "dup",
      daysAgo: 3,
    });
    await addItem(publicSource, { fingerprint: "dup", daysAgo: 5 });

    const off = new ChatbotStore(db, undefined, { enabled: false });
    await off.syncArchive();
    const none = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM archive_documents WHERE kind='source'",
    );
    assert.equal(none.rows[0].n, 0);

    const on = new ChatbotStore(db, undefined, { enabled: true });
    await on.syncArchive();
    const rows = await db.pool.query<{
      key: string;
      title: string;
      summary: string;
    }>(
      "SELECT key,title,summary FROM archive_documents WHERE kind='source' ORDER BY key",
    );
    const keys = rows.rows.map((r) => r.key).sort();
    assert.deepEqual(
      keys,
      [`source:${good}`, `source:${good2}`, `source:${first}`].sort(),
    );
    const title = rows.rows.find((r) => r.key === `source:${good}`)!;
    assert.equal(title.title, "좋은 글");
    assert.equal(title.summary, "첫 줄 요약 둘째 줄");

    // An item that is deleted or loses public status leaves on the next sync.
    await db.pool.query(
      "UPDATE source_items SET visibility='private' WHERE id=$1",
      [good],
    );
    await db.pool.query(
      'UPDATE source_items SET metadata=\'{"retentionExpired":"true"}\' WHERE id=$1',
      [good2],
    );
    await on.syncArchive();
    const after = await db.pool.query<{ key: string }>(
      "SELECT key FROM archive_documents WHERE kind='source'",
    );
    assert.deepEqual(
      after.rows.map((r) => r.key),
      [`source:${first}`],
    );

    // The limit keeps the newest.
    await db.pool.query(
      "UPDATE source_items SET visibility='public', metadata='{}' WHERE id=ANY($1)",
      [[good, good2]],
    );
    await new ChatbotStore(db, undefined, {
      enabled: true,
      limit: 1,
    }).syncArchive();
    const limited = await db.pool.query<{ key: string }>(
      "SELECT key FROM archive_documents WHERE kind='source'",
    );
    assert.equal(limited.rowCount, 1);
  } finally {
    await db.pool.query("DELETE FROM archive_documents WHERE kind='source'");
    await db.pool.query("DELETE FROM source_items WHERE id=ANY($1)", [
      created.items,
    ]);
    await db.pool.query("DELETE FROM raw_events WHERE id=ANY($1)", [
      created.raws,
    ]);
    await db.pool.query("DELETE FROM sources WHERE id=ANY($1)", [
      created.sources,
    ]);
    await db.close();
  }
});
