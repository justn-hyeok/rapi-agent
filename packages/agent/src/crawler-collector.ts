import { randomUUID } from "node:crypto";
import { z } from "zod";
import { checksumPayload } from "@rapi/core";
import {
  CrawlerClient,
  CrawlerError,
  type CreateJob,
  type Job,
  type ItemsPage,
  type Item,
} from "@rapi/crawler-client";
import type { RapiAgent } from "./rapi-agent.js";

const policySchema = z
  .object({
    enabled: z.literal(true),
    sourceId: z.string().min(1),
    tenantId: z.string().min(1),
    requirements: z.object({
      contentLevel: z.enum(["listing", "detail", "evidence"]),
      minimumItems: z.number().int().nonnegative(),
    }),
    limits: z.object({
      maxItems: z.number().int().positive(),
      maxPages: z.number().int().positive(),
      maxDepth: z.number().int().min(0).max(5),
      maxDurationSeconds: z.number().int().positive(),
      maxBytes: z.number().int().positive(),
      maxAsideRuns: z.number().int().nonnegative(),
    }),
    pipeline: z.object({
      stages: z.array(z.enum(["api", "crawl"])).min(1),
      allowEscalation: z.boolean(),
    }),
    selector: z
      .object({
        query: z.string().min(1).optional(),
        urls: z.array(z.string().url()).max(100).optional(),
      })
      .default({}),
    intervalSeconds: z.number().int().min(30).default(900),
    lookbackSeconds: z.number().int().positive().default(86400),
    deadlineSeconds: z.number().int().positive().max(7200).default(900),
  })
  .strict();
interface Collection {
  id: string;
  source_id: string;
  crawler_job_id: string | null;
  request: CreateJob;
  policy_hash: string;
  cursor_value: string | null;
  state: string;
}
interface BoundSource {
  id: string;
  kind: string;
  state: string;
  collection_policy: Record<string, unknown>;
  last_success_at: Date | null;
}
const isTerminal = (state: string) =>
  ["succeeded", "partial", "failed", "cancelled", "expired"].includes(state);
const level = (value: string) =>
  ["listing", "detail", "evidence"].indexOf(value);

export class CrawlerCollector {
  constructor(
    private readonly agent: RapiAgent,
    private readonly client: CrawlerClient,
  ) {}
  async prepare(
    sourceId: string,
    now = new Date(),
  ): Promise<Collection | null> {
    return this.agent.store.transaction(async (db) => {
      const sourceResult = await db.query<BoundSource>(
        `SELECT s.id,s.kind,s.state,s.collection_policy,c.last_success_at FROM sources s LEFT JOIN source_cursors c ON c.source_id=s.id WHERE s.id=$1 FOR UPDATE OF s`,
        [sourceId],
      );
      const source = sourceResult.rows[0];
      if (!source || source.state !== "active") return null;
      const policy = policySchema.parse(source.collection_policy.crawler);
      if (
        policy.pipeline.stages.includes("crawl") &&
        (source.kind !== "aside" ||
          source.collection_policy.visibility !== "private" ||
          typeof source.collection_policy.ownerId !== "string" ||
          !source.collection_policy.ownerId)
      )
        throw new Error(
          "Crawler browser sources require a private owner-bound Aside source",
        );
      const pending = await db.query<Collection>(
        `SELECT * FROM crawler_collection_jobs WHERE source_id=$1 AND state NOT IN ('succeeded','partial','failed','cancelled','expired','revoked') ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [sourceId],
      );
      if (pending.rows[0]) return pending.rows[0];
      const last = await db.query<{ created_at: Date }>(
        "SELECT created_at FROM crawler_collection_jobs WHERE source_id=$1 ORDER BY created_at DESC LIMIT 1",
        [sourceId],
      );
      const lastCreated = last.rows[0]?.created_at;
      if (
        lastCreated &&
        now.getTime() - lastCreated.getTime() < policy.intervalSeconds * 1000
      )
        return null;
      const id = randomUUID();
      const input: CreateJob = {
        sourceId: policy.sourceId,
        requestRef: `rapi-crawler:${id}`,
        purpose: "Collect configured newsletter source material",
        selector: {
          ...(policy.selector.query ? { query: policy.selector.query } : {}),
          ...(policy.selector.urls ? { urls: policy.selector.urls } : {}),
        },
        requirements: policy.requirements,
        pipeline: policy.pipeline,
        limits: policy.limits,
        deadlineAt: new Date(
          now.getTime() + policy.deadlineSeconds * 1000,
        ).toISOString(),
      };
      if (!policy.selector.urls?.length) {
        input.selector.since = new Date(
          source.last_success_at?.getTime() ??
            now.getTime() - policy.lookbackSeconds * 1000,
        ).toISOString();
        input.selector.until = now.toISOString();
      }
      const result = await db.query<Collection>(
        `INSERT INTO crawler_collection_jobs(id,source_id,request,policy_hash) VALUES($1,$2,$3::jsonb,$4) RETURNING *`,
        [
          id,
          sourceId,
          JSON.stringify(input),
          checksumPayload(source.collection_policy),
        ],
      );
      return result.rows[0]!;
    });
  }
  async submit(collection: Collection): Promise<Job> {
    const job = collection.crawler_job_id
      ? await this.client.get(collection.crawler_job_id)
      : await this.client.create(collection.request, collection.id);
    const revoked = await this.agent.store.transaction(async (db) => {
      const bound = await db.query<{
        state: string;
        collection_policy: Record<string, unknown>;
      }>("SELECT state,collection_policy FROM sources WHERE id=$1 FOR UPDATE", [
        collection.source_id,
      ]);
      const source = bound.rows[0];
      const available =
        !!source &&
        source.state === "active" &&
        checksumPayload(source.collection_policy) === collection.policy_hash;
      if (source && available)
        this.assertJob(collection, job, source.collection_policy);
      else if (
        job.sourceId !== collection.request.sourceId ||
        job.requestRef !== collection.request.requestRef
      )
        throw new Error("Crawler response identity mismatch");
      await db.query(
        "UPDATE crawler_collection_jobs SET crawler_job_id=$2,state=$3,updated_at=now() WHERE id=$1 AND (crawler_job_id IS NULL OR crawler_job_id=$2)",
        [
          collection.id,
          job.jobId,
          available
            ? isTerminal(job.state)
              ? "ingesting"
              : job.state
            : "revoking",
        ],
      );
      return !available;
    });
    if (revoked) {
      if (!isTerminal(job.state)) await this.client.cancel(job);
      throw new Error("Crawler source policy was revoked");
    }
    return job;
  }
  private assertJob(
    collection: Collection,
    job: Job,
    sourcePolicy: Record<string, unknown>,
  ): void {
    const policy = policySchema.parse(sourcePolicy.crawler);
    if (
      job.sourceId !== collection.request.sourceId ||
      job.tenantId !== policy.tenantId ||
      job.requestRef !== collection.request.requestRef ||
      (collection.crawler_job_id && collection.crawler_job_id !== job.jobId)
    )
      throw new Error("Crawler job identity does not match source binding");
  }
  async ingest(
    collection: Collection,
    job: Job,
    page: ItemsPage,
  ): Promise<{ inserted: number; done: boolean }> {
    return this.agent.store.transaction(async (db) => {
      const sourceResult = await db.query<BoundSource>(
        "SELECT id,kind,state,collection_policy FROM sources WHERE id=$1 FOR UPDATE",
        [collection.source_id],
      );
      const source = sourceResult.rows[0];
      if (
        !source ||
        source.state !== "active" ||
        checksumPayload(source.collection_policy) !== collection.policy_hash
      )
        throw new Error("Crawler source policy was revoked");
      const current = await db.query<Collection>(
        "SELECT * FROM crawler_collection_jobs WHERE id=$1 FOR UPDATE",
        [collection.id],
      );
      const bound = current.rows[0];
      if (
        !bound ||
        bound.crawler_job_id !== job.jobId ||
        page.jobId !== job.jobId ||
        bound.policy_hash !== collection.policy_hash
      )
        throw new Error("Crawler collection binding mismatch");
      this.assertJob(collection, job, source.collection_policy);
      let inserted = 0;
      for (const item of page.items) {
        this.assertItem(collection, item, source.collection_policy);
        const receipt = await db.query(
          "SELECT 1 FROM crawler_collection_receipts WHERE collection_id=$1 AND crawler_item_id=$2",
          [collection.id, item.itemId],
        );
        if (receipt.rowCount) continue;
        let sourceItemId: string | null = null;
        if (
          level(item.contentLevel) >=
          level(collection.request.requirements.contentLevel)
        ) {
          const saved = await this.agent.ingestExternalItem(
            collection.source_id,
            {
              externalId: item.externalId ?? item.canonicalUrl,
              url: item.canonicalUrl,
              title: item.title,
              body: item.text,
              author: null,
              publishedAt: item.publishedAt,
              metadata: {
                ...item.metadata,
                crawler: {
                  jobId: job.jobId,
                  itemId: item.itemId,
                  sequence: item.sequence,
                  contentLevel: item.contentLevel,
                  provenance: item.provenance,
                  analysis: item.analysis,
                },
              },
            },
            new Date(item.collectedAt),
            db,
          );
          sourceItemId = saved.itemId;
          if (saved.inserted) inserted++;
        }
        await db.query(
          "INSERT INTO crawler_collection_receipts VALUES($1,$2,$3)",
          [collection.id, item.itemId, sourceItemId],
        );
      }
      const done =
        page.sealed && page.nextCursor === null && isTerminal(job.state);
      await db.query(
        "UPDATE crawler_collection_jobs SET cursor_value=$2,state=$3,failure_code=$4,updated_at=now() WHERE id=$1",
        [
          collection.id,
          page.nextCursor ?? bound.cursor_value,
          done ? job.state : isTerminal(job.state) ? "ingesting" : job.state,
          job.failure?.code ?? null,
        ],
      );
      if (done) {
        if (job.state === "succeeded")
          await db.query(
            `INSERT INTO source_cursors(source_id,cursor_value,last_success_at) VALUES($1,$2,$3) ON CONFLICT(source_id) DO UPDATE SET cursor_value=$2,last_success_at=$3,last_error=NULL,failure_count=0,updated_at=now()`,
            [
              collection.source_id,
              collection.request.selector.until ?? job.updatedAt,
              collection.request.selector.until ?? job.updatedAt,
            ],
          );
        else
          await db.query(
            `INSERT INTO source_cursors(source_id,last_error,failure_count) VALUES($1,$2,1) ON CONFLICT(source_id) DO UPDATE SET last_error=$2,failure_count=source_cursors.failure_count+1,updated_at=now()`,
            [
              collection.source_id,
              `Crawler ${job.state}: ${job.failure?.code ?? "INCOMPLETE"}`,
            ],
          );
      }
      return { inserted, done };
    });
  }
  private assertItem(
    collection: Collection,
    item: Item,
    policy: Record<string, unknown>,
  ): void {
    const visibility = policy.visibility ?? "private";
    if (
      item.sourceId !== collection.request.sourceId ||
      item.visibility !== visibility ||
      (level(item.contentLevel) >= level("detail") && !item.text.trim()) ||
      (item.contentLevel === "evidence" && !item.provenance.evidence.length)
    )
      throw new Error("Crawler item violates source policy or content level");
  }
  async runOnce(): Promise<void> {
    const sources = await this.agent.store.pool.query<{ id: string }>(
      "SELECT id FROM sources WHERE state='active' AND collection_policy->'crawler'->>'enabled'='true' ORDER BY created_at",
    );
    for (const source of sources.rows) {
      try {
        const collection = await this.prepare(source.id);
        if (!collection) continue;
        let job = await this.submit(collection);
        collection.crawler_job_id = job.jobId;
        for (let pages = 0; pages < 10; pages++) {
          const page = await this.client.items(
            job.jobId,
            collection.cursor_value,
          );
          const result = await this.ingest(collection, job, page);
          if (result.done || !page.nextCursor) break;
          collection.cursor_value = page.nextCursor;
          job = await this.client.get(job.jobId);
        }
      } catch {
        await this.agent.store.recordSourceFailure(
          source.id,
          "Crawler collection or ingestion failed",
        );
      }
    }
    await this.revokeUnavailable();
  }
  async revokeUnavailable(): Promise<void> {
    const deleted = await this.agent.store.pool.query<{
      crawler_job_id: string;
    }>(
      "SELECT crawler_job_id FROM crawler_collection_revocations ORDER BY requested_at LIMIT 100",
    );
    for (const row of deleted.rows) {
      let cleaned = false;
      try {
        let job = await this.client.get(row.crawler_job_id);
        if (!isTerminal(job.state)) job = await this.client.cancel(job);
        if (isTerminal(job.state)) {
          await this.client.purge(job);
          cleaned = true;
        }
      } catch (error) {
        if (error instanceof CrawlerError && error.status === 404)
          cleaned = true;
        else throw error;
      }
      if (cleaned)
        await this.agent.store.pool.query(
          "DELETE FROM crawler_collection_revocations WHERE crawler_job_id=$1",
          [row.crawler_job_id],
        );
    }

    const pending = await this.agent.store.pool.query<
      Collection & {
        source_state: string;
        collection_policy: Record<string, unknown>;
      }
    >(
      `SELECT c.*,s.state AS source_state,s.collection_policy FROM crawler_collection_jobs c JOIN sources s ON s.id=c.source_id WHERE c.state<>'revoked'`,
    );
    for (const collection of pending.rows) {
      if (
        collection.source_state === "active" &&
        checksumPayload(collection.collection_policy) === collection.policy_hash
      )
        continue;
      let cleaned = true;
      if (collection.crawler_job_id) {
        try {
          let job = await this.client.get(collection.crawler_job_id);
          if (!isTerminal(job.state)) job = await this.client.cancel(job);
          if (isTerminal(job.state)) await this.client.purge(job);
          else cleaned = false;
        } catch (error) {
          if (!(error instanceof CrawlerError && error.status === 404))
            throw error;
        }
      }
      await this.agent.store.pool.query(
        "UPDATE crawler_collection_jobs SET state=$2,failure_code='SOURCE_REVOKED',updated_at=now() WHERE id=$1",
        [collection.id, cleaned ? "revoked" : "revoking"],
      );
    }
  }
}
