import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWithdrawals } from "../../scripts/blog-withdrawals.mjs";
import { it } from "node:test";
import pg from "pg";
import { expireSourceContent } from "../../scripts/expire-source-content.mjs";
import { PostgresStore } from "@rapi/db";
import type { NormalizedItem } from "@rapi/core";

it("expires private/public bodies at their own ages, preserves fresh data, and is repeatable", async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const schema = `retention_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  const sourceId = randomUUID();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const rawIds = ids.map(() => randomUUID());
  const now = new Date("2030-01-01T00:00:00Z");
  const directory = await mkdtemp(join(tmpdir(), "rapi-expiry-e2e-"));
  const withdrawalsFile = join(directory, "withdrawals.json");
  const database = new URL(process.env.DATABASE_URL!);
  database.searchParams.set("options", `-csearch_path=${schema}`);
  const store = new PostgresStore(database.toString());
  try {
    for (const name of ["0001_phase_zero.sql", "0002_mvp.sql"])
      await client.query(
        await readFile(`packages/db/migrations/${name}`, "utf8"),
      );
    await client.query(
      "INSERT INTO sources(id,kind,locator) VALUES($1,'rss',$2)",
      [sourceId, `https://expiry.example/${sourceId}`],
    );
    for (let i = 0; i < ids.length; i++) {
      const at = new Date(
        now.getTime() - [31, 91, 31, 31, 91][i]! * 86_400_000,
      );
      await client.query(
        'INSERT INTO raw_events(id,source_id,canonical_payload_hash,payload,collected_at) VALUES($1::uuid,$2,$1::text,\'{"body":"secret source body"}\',$3)',
        [rawIds[i], sourceId, at],
      );
      await client.query(
        "INSERT INTO source_items(id,raw_event_id,normalizer_version,canonical_url,title,body,collected_at,visibility,content_fingerprint) VALUES($1::uuid,$2,'expiry-v1','https://expiry.example/item','source title','source body',$3,$4,$1::text)",
        [
          ids[i],
          rawIds[i],
          at,
          ["private", "public", "public", "private", "public"][i],
        ],
      );
    }
    const subscriptionId = randomUUID();
    await client.query(
      "INSERT INTO subscriptions(id,owner_id,name,cadence,channels) VALUES($1,'retention-test','retention-test','immediate','{}')",
      [subscriptionId],
    );
    for (const index of [3, 4]) {
      const batchId = randomUUID();
      await client.query(
        "INSERT INTO delivery_batches(id,subscription_id,period_start,period_end,renderer_version,state) VALUES($1,$2,$3,$4,'retention-test',$5)",
        [
          batchId,
          subscriptionId,
          new Date(now.getTime() - index * 86_400_000),
          now,
          index === 3 ? "ready" : "delivered",
        ],
      );
      await client.query(
        "INSERT INTO delivery_batch_items(batch_id,source_item_id,position) VALUES($1,$2,0)",
        [batchId, ids[index]],
      );
      if (index === 4)
        await client.query(
          "INSERT INTO mdx_publications(id,batch_id,visibility,file_path,content_hash) VALUES($1,$2,'public',$3,'test')",
          [randomUUID(), batchId, `expiry-${batchId}.mdx`],
        );
    }
    await client.query(
      "INSERT INTO summaries(id,purpose,cache_key,model_policy_version,prompt_version,content,evidence_item_ids) VALUES($1,'item','expired-summary','v1','v1','derived content',$2)",
      [randomUUID(), [ids[0]]],
    );
    const before = await client.query(
      "SELECT row_to_json(si) AS row FROM source_items si WHERE id=ANY($1::uuid[]) ORDER BY id",
      [ids],
    );
    const plan = await expireSourceContent(client, { now });
    assert.equal(plan.applied, false);
    const afterPlan = await client.query(
      "SELECT row_to_json(si) AS row FROM source_items si WHERE id=ANY($1::uuid[]) ORDER BY id",
      [ids],
    );
    assert.deepEqual(afterPlan.rows, before.rows);
    assert.equal(plan.pendingItemsDeferred, 1);
    assert.equal(plan.publishedItems, 1);
    await assert.rejects(
      expireSourceContent(client, { apply: true, now }),
      /Published content handling/,
    );
    const afterRejected = await client.query(
      "SELECT row_to_json(si) AS row FROM source_items si WHERE id=ANY($1::uuid[]) ORDER BY id",
      [ids],
    );
    assert.deepEqual(afterRejected.rows, before.rows);
    const applied = await expireSourceContent(client, {
      apply: true,
      publishedHistory: "withdraw",
      withdrawalsFile,
      now,
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.expiredItems, 3);
    assert.equal(applied.rawBodiesExpired, 3);
    assert.equal(applied.summariesRemoved, 1);
    assert.equal(applied.publicationsWithdrawn, 1);
    assert.equal((await readWithdrawals(withdrawalsFile, true)).length, 1);
    assert.equal(
      (
        await client.query<{ visibility: string }>(
          "SELECT visibility FROM mdx_publications",
        )
      ).rows[0]?.visibility,
      "private",
    );
    const result = await client.query<{
      id: string;
      body: string;
      metadata: Record<string, unknown>;
    }>("SELECT id,body,metadata FROM source_items WHERE id=ANY($1::uuid[])", [
      ids,
    ]);
    assert.equal(
      result.rows.find((row: { id: string }) => row.id === ids[0])?.body,
      "",
    );
    assert.equal(
      result.rows.find((row: { id: string }) => row.id === ids[1])?.body,
      "",
    );
    assert.equal(
      result.rows.find((row: { id: string }) => row.id === ids[2])?.body,
      "source body",
    );
    assert.equal(
      result.rows.find((row) => row.id === ids[3])?.body,
      "source body",
    );
    const rawResult = await client.query<{
      id: string;
      payload: { retentionExpired?: boolean; body?: string };
    }>("SELECT id,payload FROM raw_events WHERE id=ANY($1::uuid[])", [rawIds]);
    assert.equal(
      rawResult.rows.find((row: { id: string }) => row.id === rawIds[0])
        ?.payload.retentionExpired,
      true,
    );
    assert.equal(
      rawResult.rows.find((row: { id: string }) => row.id === rawIds[2])
        ?.payload.body,
      "secret source body",
    );
    assert.equal(
      (
        await expireSourceContent(client, {
          apply: true,
          publishedHistory: "withdraw",
          withdrawalsFile,
          now,
        })
      ).expiredItems,
      0,
    );
    const normalized: NormalizedItem = {
      id: randomUUID(),
      rawEventId: rawIds[0]!,
      sourceId,
      normalizerVersion: "expiry-v1",
      canonicalUrl: "https://expiry.example/old",
      title: "old duplicate",
      body: "old source body",
      author: null,
      publishedAt: null,
      collectedAt: now,
      visibility: "public",
      contentFingerprint: "old-duplicate",
      metadata: {},
      categories: [],
    };
    assert.deepEqual(
      await store.saveItem(normalized, "expired duplicate summary"),
      { id: ids[0], inserted: false },
    );
    await assert.rejects(
      store.saveItem(
        { ...normalized, normalizerVersion: "new-version" },
        "new summary",
      ),
      /expired/,
    );
    const newRawId = randomUUID();
    await client.query(
      "INSERT INTO raw_events(id,source_id,canonical_payload_hash,payload,collected_at) VALUES($1::uuid,$2,$1::text,'{}',$3)",
      [newRawId, sourceId, now],
    );
    const fresh = await store.saveItem(
      {
        ...normalized,
        id: randomUUID(),
        rawEventId: newRawId,
        title: "fresh item",
        body: "fresh source body",
        contentFingerprint: "fresh-item",
      },
      "fresh summary",
    );
    assert.equal(fresh.inserted, true);
    const expiredBatch = await client.query<{ batch_id: string }>(
      "SELECT batch_id FROM delivery_batch_items WHERE source_item_id=$1",
      [ids[4]],
    );
    await assert.rejects(
      store.recordPublication(
        expiredBatch.rows[0]!.batch_id,
        "public",
        "republication.mdx",
        "new-hash",
      ),
      /expired/,
    );
  } finally {
    await store.close();
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
    await rm(directory, { recursive: true, force: true });
  }
});
