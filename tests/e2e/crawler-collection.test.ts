import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { PostgresStore } from "@rapi/db";
import { CrawlerClient } from "@rapi/crawler-client";
import {
  CrawlerCollector,
  RapiAgent,
  RecordingDeliveryAdapter,
  RecordingOmpAdapter,
} from "@rapi/agent";

const integrationEnabled = !!process.env.CRAWLER_TEST_ENDPOINT;
test(
  "real crawler ingestion is durable, atomic, private, deduplicated and respects tombstones",
  { skip: !integrationEnabled, timeout: 60000 },
  async () => {
    const database = process.env.DATABASE_URL;
    if (!database || !new URL(database).pathname.endsWith("_test"))
      throw new Error("Crawler E2E requires a disposable _test database");
    const schema = `crawler_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: database });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    const isolated = new URL(database);
    isolated.searchParams.set("options", `-csearch_path=${schema}`);
    const store = new PostgresStore(isolated.toString(), {
      privacyHmacKey: "a".repeat(64),
    });
    const agent = new RapiAgent(
      store,
      new RecordingDeliveryAdapter(),
      new RecordingOmpAdapter(),
    );
    const client = new CrawlerClient(
      process.env.CRAWLER_TEST_ENDPOINT!,
      process.env.CRAWLER_CALLER_TOKEN!,
    );
    const collector = new CrawlerCollector(agent, client);
    try {
      // Isolate the existing raw/normalized ingestion tables plus crawler integration.
      for (const name of [
        "0001_phase_zero.sql",
        "0002_mvp.sql",
        "0014_crawler_collection.sql",
      ])
        await admin.query(
          await readFile(`packages/db/migrations/${name}`, "utf8"),
        );
      await store.pool.query(
        "CREATE TABLE privacy_event_tombstones(source_id uuid,event_ref text,raw_id uuid,PRIMARY KEY(source_id,event_ref))",
      );
      const sourceId = await store.createSource(
        "rss",
        `crawler-fixture:${randomUUID()}`,
        "private",
      );
      const policy = {
        visibility: "private",
        ownerId: "owner",
        crawler: {
          enabled: true,
          sourceId: "fixture",
          tenantId: "rapi",
          requirements: { contentLevel: "detail", minimumItems: 2 },
          limits: {
            maxItems: 10,
            maxPages: 20,
            maxDepth: 1,
            maxDurationSeconds: 30,
            maxBytes: 1000000,
            maxAsideRuns: 0,
          },
          pipeline: { stages: ["api", "crawl"], allowEscalation: true },
          intervalSeconds: 30,
          lookbackSeconds: 86400,
          deadlineSeconds: 120,
        },
      };
      // Browser-capable collections use the same owner-only source semantics as Aside.
      await store.pool.query(
        "UPDATE sources SET kind='aside',collection_policy=$2::jsonb WHERE id=$1",
        [sourceId, JSON.stringify(policy)],
      );
      const concurrent = await Promise.all([
        collector.prepare(sourceId),
        collector.prepare(sourceId),
      ]);
      assert.equal(concurrent[0]?.id, concurrent[1]?.id);
      const collection = concurrent[0]!;
      let job = await collector.submit(collection);
      const retry = await new CrawlerCollector(agent, client).submit(
        collection,
      );
      assert.equal(job.jobId, retry.jobId);
      collection.crawler_job_id = job.jobId;
      const until = Date.now() + 30000;
      while (
        !["succeeded", "partial", "failed", "blocked"].includes(job.state) &&
        Date.now() < until
      ) {
        await new Promise((r) => setTimeout(r, 100));
        job = await client.get(job.jobId);
      }
      assert.equal(job.state, "succeeded", JSON.stringify(job));
      const page = await client.items(job.jobId);
      assert.equal(page.items.length, 2);
      const first = await collector.ingest(collection, job, page);
      assert.deepEqual(first, { inserted: 2, done: true });
      assert.deepEqual(
        await new CrawlerCollector(agent, client).ingest(collection, job, page),
        { inserted: 0, done: true },
      );
      const count = await store.pool.query<{ count: string }>(
        "SELECT count(*) FROM source_items",
      );
      assert.equal(count.rows[0]?.count, "2");
      const normalized = await store.pool.query<{
        body: string;
        visibility: string;
        metadata: { crawler: { provenance: { engine: string } } };
      }>("SELECT body,visibility,metadata FROM source_items ORDER BY body");
      assert.ok(
        normalized.rows.every(
          (r) =>
            (r.visibility === "private" && r.body.includes("original")) ||
            r.body.includes("Original"),
        ),
      );
      assert.ok(
        normalized.rows.some(
          (r) => r.metadata.crawler.provenance.engine === "node_playwright",
        ),
      );
      assert.equal((await store.activeSourceIds()).includes(sourceId), false);
      // The ordinary tombstone mechanism also fences crawler replay after content deletion.
      const external = page.items[0]!.externalId!;
      const retired = randomUUID();
      const ref =
        "hmac:v1:" +
        createHmac("sha256", Buffer.from("a".repeat(64), "hex"))
          .update("event\0id:" + external)
          .digest("hex");
      await store.pool.query(
        "INSERT INTO privacy_event_tombstones VALUES($1,$2,$3)",
        [sourceId, ref, retired],
      );
      const copy = {
        ...page,
        items: [{ ...page.items[0]!, itemId: randomUUID() }],
      };
      assert.equal((await collector.ingest(collection, job, copy)).inserted, 0);
      // A later invalid item rolls back every raw/item/receipt write in the page.
      const other = await store.createSource(
        "aside",
        `crawler-atomic:${randomUUID()}`,
        "private",
      );
      await store.pool.query(
        "UPDATE sources SET collection_policy=$2::jsonb WHERE id=$1",
        [
          other,
          JSON.stringify({
            ...policy,
            crawler: {
              ...policy.crawler,
              sourceId: "browser",
              selector: {
                urls: [`${process.env.CRAWLER_FIXTURE_URL!}/article`],
              },
              pipeline: { stages: ["crawl"], allowEscalation: false },
              requirements: { contentLevel: "detail", minimumItems: 1 },
            },
          }),
        ],
      );
      const atomic = await collector.prepare(other);
      assert.ok(atomic);
      const atomicJob = await collector.submit(atomic);
      atomic.crawler_job_id = atomicJob.jobId;
      const item = {
        ...page.items[1]!,
        sourceId: "browser",
        itemId: randomUUID(),
      };
      const invalid = {
        ...item,
        itemId: randomUUID(),
        visibility: "public" as const,
      };
      await assert.rejects(
        collector.ingest(atomic, atomicJob, {
          jobId: atomicJob.jobId,
          sealed: false,
          nextCursor: null,
          items: [item, invalid],
        }),
        /source policy/,
      );
      assert.equal(
        (
          await store.pool.query<{ count: string }>(
            "SELECT count(*) FROM raw_events WHERE source_id=$1",
            [other],
          )
        ).rows[0]?.count,
        "0",
      );
      await store.pool.query(
        "UPDATE sources SET state='disabled' WHERE id=$1",
        [other],
      );
      await assert.rejects(
        collector.ingest(atomic, atomicJob, {
          jobId: atomicJob.jobId,
          sealed: false,
          nextCursor: null,
          items: [item],
        }),
        /revoked/,
      );
      await collector.revokeUnavailable();
      assert.ok(
        ["cancelled", "cancelling"].includes(
          (await client.get(atomicJob.jobId)).state,
        ),
      );

      await store.pool.query("DELETE FROM sources WHERE id=$1", [other]);
      assert.equal(
        (
          await store.pool.query<{ count: string }>(
            "SELECT count(*) FROM crawler_collection_revocations",
          )
        ).rows[0]?.count,
        "1",
      );
      let cancelled = await client.get(atomicJob.jobId);
      const cancelDeadline = Date.now() + 15000;
      while (cancelled.state === "cancelling" && Date.now() < cancelDeadline) {
        await new Promise((r) => setTimeout(r, 100));
        cancelled = await client.get(atomicJob.jobId);
      }
      assert.equal(cancelled.state, "cancelled");
      await collector.revokeUnavailable();
      assert.equal(
        (
          await store.pool.query<{ count: string }>(
            "SELECT count(*) FROM crawler_collection_revocations",
          )
        ).rows[0]?.count,
        "0",
      );
      assert.equal((await client.items(atomicJob.jobId)).items.length, 0);
    } finally {
      await store.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
