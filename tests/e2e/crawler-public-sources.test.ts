import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { PostgresStore } from "@rapi/db";
import { CrawlerClient } from "@rapi/crawler-client";
import { evaluateIssue, type SourceResult } from "@rapi/crawler-client/issue";
import {
  CrawlerCollector,
  RapiAgent,
  RecordingDeliveryAdapter,
  RecordingOmpAdapter,
} from "@rapi/agent";

test(
  "public original evidence reaches private agent ingestion without duplicate receipts",
  { skip: !process.env.CRAWLER_PUBLIC_TEST_ENDPOINT, timeout: 180000 },
  async () => {
    const database = process.env.DATABASE_URL;
    if (!database || !new URL(database).pathname.endsWith("_test"))
      throw new Error("Disposable _test PostgreSQL required");
    const schema = `crawler_public_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: database });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    const isolated = new URL(database);
    isolated.searchParams.set("options", `-csearch_path=${schema}`);
    const store = new PostgresStore(isolated.toString(), {
      privacyHmacKey: "a".repeat(64),
    });
    const client = new CrawlerClient(
      process.env.CRAWLER_PUBLIC_TEST_ENDPOINT!,
      process.env.CRAWLER_CALLER_TOKEN!,
    );
    const agent = new RapiAgent(
      store,
      new RecordingDeliveryAdapter(),
      new RecordingOmpAdapter(),
    );
    const collector = new CrawlerCollector(agent, client);
    try {
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
      const results: SourceResult[] = [];
      const until = new Date();
      const sourceIds: string[] = process.env.CRAWLER_PUBLIC_TEST_SOURCES
        ? (JSON.parse(process.env.CRAWLER_PUBLIC_TEST_SOURCES) as string[])
        : ["huggingface", "github-changelog", "cloudflare"];
      assert.ok(sourceIds.length >= 3);
      for (const sourceId of sourceIds) {
        const local = await store.createSource(
          "rss",
          `public-crawler-test:${sourceId}:${randomUUID()}`,
          "private",
        );
        const policy = {
          visibility: "private",
          ownerId: "test-owner",
          crawler: {
            enabled: true,
            sourceId,
            tenantId: "rapi",
            requirements: { contentLevel: "evidence", minimumItems: 1 },
            pipeline: { stages: ["api", "crawl"], allowEscalation: true },
            limits: {
              maxItems: 5,
              maxPages: 40,
              maxDepth: 1,
              maxDurationSeconds: 60,
              maxBytes: 10000000,
              maxAsideRuns: 0,
            },
            intervalSeconds: 60,
            lookbackSeconds: 604800,
            deadlineSeconds: 180,
          },
        };
        await store.pool.query(
          "UPDATE sources SET kind='aside',collection_policy=$2::jsonb WHERE id=$1",
          [local, JSON.stringify(policy)],
        );
        const collection = await collector.prepare(local, until);
        assert.ok(collection);
        // Adopt this harness's already collected public job in the disposable
        // schema, avoiding a second network crawl (especially Reddit 429).
        const existingJobs: Record<string, string> = JSON.parse(
          process.env.CRAWLER_PUBLIC_TEST_JOBS ?? "{}",
        ) as Record<string, string>;
        if (existingJobs[sourceId]) {
          const existingJob = await client.get(existingJobs[sourceId]!);
          assert.equal(existingJob.sourceId, sourceId);
          assert.equal(existingJob.tenantId, "rapi");
          collection.request.requestRef = existingJob.requestRef;
          collection.crawler_job_id = existingJob.jobId;
          await store.pool.query(
            "UPDATE crawler_collection_jobs SET request=$2::jsonb,crawler_job_id=$3 WHERE id=$1",
            [
              collection.id,
              JSON.stringify(collection.request),
              existingJob.jobId,
            ],
          );
        }
        let job = await collector.submit(collection);
        collection.crawler_job_id = job.jobId;
        const end = Date.now() + 90000;
        while (
          !["succeeded", "partial", "failed", "blocked", "expired"].includes(
            job.state,
          ) &&
          Date.now() < end
        ) {
          await new Promise((r) => setTimeout(r, 100));
          job = await client.get(job.jobId);
        }
        assert.equal(
          job.state,
          "succeeded",
          `${sourceId}: ${job.failure?.code}`,
        );
        const page = await client.items(job.jobId);
        assert.equal(page.nextCursor, null);
        const first = await collector.ingest(collection, job, page);
        assert.equal(first.inserted, page.items.length);
        assert.equal(first.done, true);
        assert.equal(
          (await collector.ingest(collection, job, page)).inserted,
          0,
        );
        results.push({ sourceId, job, items: page.items });
      }
      const issue = evaluateIssue(results, {
        since: new Date(until.getTime() - 604800000).toISOString(),
        until: until.toISOString(),
        minimumItems: 10,
        minimumSources: 3,
        minimumTextBytes: 80,
      });
      assert.equal(issue.state, "ready_for_editorial_review");
      assert.equal(issue.publicationAuthorized, false);
      const records = await store.pool.query<{
        count: string;
        private_count: string;
      }>(
        "SELECT count(*) AS count,count(*) FILTER(WHERE visibility='private') AS private_count FROM source_items",
      );
      const originals = results.reduce((n, r) => n + r.items.length, 0);
      assert.equal(Number(records.rows[0]!.count), originals);
      assert.equal(Number(records.rows[0]!.private_count), originals);
      console.log(
        JSON.stringify({
          event: "public_agent_ingestion",
          originals,
          issueOriginals: issue.accepted.length,
          domains: issue.sourceCount,
          duplicatesInserted: 0,
          publicationAuthorized: false,
        }),
      );
    } finally {
      await store.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
