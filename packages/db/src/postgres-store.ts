import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type {
  BriefingItem,
  DeliveryTarget,
  FrozenBatch,
  NormalizedItem,
  SubscriptionInput,
  Visibility,
} from "@rapi/core";

interface RawEventResult {
  id: string;
  inserted: boolean;
}

interface DeliveryAttemptResult {
  id: string;
  skip: boolean;
  attempts: number;
}

export class PostgresStore {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resetForTests(): Promise<void> {
    const database = await this.pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    if (!database.rows[0]?.name.endsWith("_test"))
      throw new Error("Refusing to reset a database without an _test suffix");
    await this.pool
      .query(`TRUNCATE chatops_memory_events, chatops_memory, chatops_events, chatops_runs,
      chat_messages, chat_channels, callback_events, execution_attempts, approvals, task_revisions,
      task_requests, mdx_publications, delivery_attempts, delivery_batch_items, delivery_batches,
      subscriptions, summaries, classifications, item_relations, source_items, queue_jobs,
      source_cursors, raw_events, sources RESTART IDENTITY CASCADE`);
  }

  async createSource(
    kind: string,
    locator: string,
    visibility: Visibility,
  ): Promise<string> {
    const id = randomUUID();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO sources (id, kind, locator, collection_policy)
       VALUES ($1, $2, $3, jsonb_build_object('visibility', $4::text))
       ON CONFLICT (kind, locator) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [id, kind, locator, visibility],
    );
    return result.rows[0]!.id;
  }

  async sourceVisibility(sourceId: string): Promise<Visibility> {
    const result = await this.pool.query<{ visibility: Visibility }>(
      `SELECT COALESCE(collection_policy->>'visibility', 'private')::text AS visibility FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (!result.rows[0]) throw new Error("Source not found");
    return result.rows[0].visibility;
  }

  async insertRawEvent(
    sourceId: string,
    externalId: string | null,
    checksum: string,
    payload: unknown,
    collectedAt: Date,
  ): Promise<RawEventResult> {
    const id = randomUUID();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO raw_events (id, source_id, external_event_id, canonical_payload_hash, payload, collected_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        id,
        sourceId,
        externalId,
        checksum,
        JSON.stringify(payload),
        collectedAt,
      ],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, inserted: true };
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM raw_events WHERE source_id = $1 AND
       (($2::text IS NOT NULL AND external_event_id = $2) OR ($2::text IS NULL AND canonical_payload_hash = $3))`,
      [sourceId, externalId, checksum],
    );
    if (!existing.rows[0])
      throw new Error("Conflicting raw event could not be resolved");
    return { id: existing.rows[0].id, inserted: false };
  }

  async saveCursor(
    sourceId: string,
    cursor: string | null,
    etag: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO source_cursors (source_id, cursor_value, etag, last_success_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT (source_id) DO UPDATE
       SET cursor_value = EXCLUDED.cursor_value, etag = EXCLUDED.etag, last_success_at = now(),
           last_error = NULL, failure_count = 0, updated_at = now()`,
      [sourceId, cursor, etag],
    );
  }

  async recordSourceFailure(sourceId: string, message: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO source_cursors (source_id, last_error, failure_count)
       VALUES ($1, $2, 1) ON CONFLICT (source_id) DO UPDATE
       SET last_error = EXCLUDED.last_error, failure_count = source_cursors.failure_count + 1, updated_at = now()`,
      [sourceId, message.slice(0, 500)],
    );
  }

  async getCursor(sourceId: string): Promise<{
    cursor: string | null;
    etag: string | null;
    failureCount: number;
  } | null> {
    const result = await this.pool.query<{
      cursor_value: string | null;
      etag: string | null;
      failure_count: number;
    }>(
      "SELECT cursor_value, etag, failure_count FROM source_cursors WHERE source_id = $1",
      [sourceId],
    );
    const row = result.rows[0];
    return row
      ? {
          cursor: row.cursor_value,
          etag: row.etag,
          failureCount: row.failure_count,
        }
      : null;
  }

  async saveItem(
    item: NormalizedItem,
    summary: string,
  ): Promise<{ id: string; inserted: boolean }> {
    return this.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO source_items
          (id, raw_event_id, normalizer_version, canonical_url, title, body, author, published_at,
           collected_at, visibility, content_fingerprint, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
         ON CONFLICT (raw_event_id, normalizer_version) DO NOTHING RETURNING id`,
        [
          item.id,
          item.rawEventId,
          item.normalizerVersion,
          item.canonicalUrl,
          item.title,
          item.body,
          item.author,
          item.publishedAt,
          item.collectedAt,
          item.visibility,
          item.contentFingerprint,
          JSON.stringify({ ...item.metadata, sourceId: item.sourceId }),
        ],
      );
      if (!result.rows[0]) {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM source_items WHERE raw_event_id=$1 AND normalizer_version=$2",
          [item.rawEventId, item.normalizerVersion],
        );
        return { id: existing.rows[0]!.id, inserted: false };
      }
      for (const category of item.categories) {
        await client.query(
          `INSERT INTO classifications (id, source_item_id, taxonomy_version, label, score, evidence)
           VALUES ($1,$2,'rules-v1',$3,1,'deterministic keyword rule') ON CONFLICT DO NOTHING`,
          [randomUUID(), item.id, category],
        );
      }
      const cacheKey = `${item.id}:item:rules-v1:summary-v1`;
      await client.query(
        `INSERT INTO summaries (id,purpose,cache_key,model_policy_version,prompt_version,content,evidence_item_ids)
         VALUES ($1,'item',$2,'rules-v1','summary-v1',$3,$4::uuid[]) ON CONFLICT (cache_key) DO NOTHING`,
        [randomUUID(), cacheKey, summary, [item.id]],
      );
      const related = await client.query<{ id: string }>(
        `SELECT id FROM source_items WHERE id <> $1 AND (canonical_url=$2 OR content_fingerprint=$3) LIMIT 1`,
        [item.id, item.canonicalUrl, item.contentFingerprint],
      );
      if (related.rows[0]) {
        await client.query(
          `INSERT INTO item_relations (source_item_id,related_item_id,relation,policy_version)
           VALUES ($1,$2,'duplicate_candidate','dedup-v1') ON CONFLICT DO NOTHING`,
          [item.id, related.rows[0].id],
        );
      }
      return { id: item.id, inserted: true };
    });
  }

  async createSubscription(input: SubscriptionInput): Promise<string> {
    const id = randomUUID();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO subscriptions
       (id,owner_id,name,source_ids,categories,include_keywords,exclude_keywords,cadence,timezone,channels,max_items)
       VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT (owner_id,name) DO UPDATE SET source_ids=EXCLUDED.source_ids,categories=EXCLUDED.categories,
       include_keywords=EXCLUDED.include_keywords,exclude_keywords=EXCLUDED.exclude_keywords,
       cadence=EXCLUDED.cadence,timezone=EXCLUDED.timezone,channels=EXCLUDED.channels,
       max_items=EXCLUDED.max_items,active=true,updated_at=now() RETURNING id`,
      [
        id,
        input.ownerId,
        input.name,
        input.sourceIds,
        input.categories,
        input.includeKeywords,
        input.excludeKeywords,
        input.cadence,
        input.timezone,
        JSON.stringify(input.channels),
        input.maxItems,
      ],
    );
    return result.rows[0]!.id;
  }

  async deactivateSubscription(
    ownerId: string,
    name: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE subscriptions SET active=false,updated_at=now() WHERE owner_id=$1 AND name=$2 AND active=true",
      [ownerId, name],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async freezeBatch(
    subscriptionId: string,
    periodStart: Date,
    periodEnd: Date,
    rendererVersion = "briefing-v1",
  ): Promise<FrozenBatch> {
    return this.transaction(async (client) => {
      const subscription = await client.query<{
        source_ids: string[];
        categories: string[];
        include_keywords: string[];
        exclude_keywords: string[];
        channels: DeliveryTarget[];
        max_items: number;
      }>(
        "SELECT source_ids,categories,include_keywords,exclude_keywords,channels,max_items FROM subscriptions WHERE id=$1 AND active=true",
        [subscriptionId],
      );
      const sub = subscription.rows[0];
      if (!sub) throw new Error("Active subscription not found");
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM delivery_batches WHERE subscription_id=$1 AND period_start=$2 AND period_end=$3",
        [subscriptionId, periodStart, periodEnd],
      );
      let batchId = existing.rows[0]?.id;
      if (!batchId) {
        batchId = randomUUID();
        await client.query(
          "INSERT INTO delivery_batches (id,subscription_id,period_start,period_end,renderer_version,state) VALUES ($1,$2,$3,$4,$5,'ready')",
          [batchId, subscriptionId, periodStart, periodEnd, rendererVersion],
        );
        const rows = await client.query<{
          id: string;
          title: string;
          body: string;
          canonical_url: string;
          visibility: Visibility;
          source_id: string;
          categories: string[];
        }>(
          `SELECT si.id,si.title,si.body,si.canonical_url,si.visibility,si.metadata->>'sourceId' AS source_id,
           COALESCE(array_agg(DISTINCT c.label) FILTER (WHERE c.label IS NOT NULL),'{}') AS categories
           FROM source_items si LEFT JOIN classifications c ON c.source_item_id=si.id
           WHERE si.collected_at >= $1 AND si.collected_at < $2
           GROUP BY si.id ORDER BY COALESCE(si.published_at,si.collected_at) DESC`,
          [periodStart, periodEnd],
        );
        const matches = rows.rows
          .filter((row) => {
            const haystack = `${row.title} ${row.body}`.toLowerCase();
            return (
              (sub.source_ids.length === 0 ||
                sub.source_ids.includes(row.source_id)) &&
              (sub.categories.length === 0 ||
                sub.categories.some((category) =>
                  row.categories.includes(category),
                )) &&
              (sub.include_keywords.length === 0 ||
                sub.include_keywords.some((keyword) =>
                  haystack.includes(keyword.toLowerCase()),
                )) &&
              !sub.exclude_keywords.some((keyword) =>
                haystack.includes(keyword.toLowerCase()),
              )
            );
          })
          .slice(0, sub.max_items);
        for (const [position, item] of matches.entries()) {
          await client.query(
            "INSERT INTO delivery_batch_items (batch_id,source_item_id,position) VALUES ($1,$2,$3)",
            [batchId, item.id, position],
          );
        }
      }
      return this.loadBatch(client, batchId, sub.channels);
    });
  }

  private async loadBatch(
    client: PoolClient,
    batchId: string,
    targets?: DeliveryTarget[],
  ): Promise<FrozenBatch> {
    const batch = await client.query<{
      id: string;
      subscription_id: string;
      period_start: Date;
      period_end: Date;
      renderer_version: string;
      state: string;
      channels: DeliveryTarget[];
    }>(
      `SELECT b.*,s.channels FROM delivery_batches b JOIN subscriptions s ON s.id=b.subscription_id WHERE b.id=$1`,
      [batchId],
    );
    const row = batch.rows[0];
    if (!row) throw new Error("Batch not found");
    const items = await client.query<
      BriefingItem & { summary: string; categories: string[] }
    >(
      `SELECT si.id,si.title,si.canonical_url AS "canonicalUrl",si.visibility,
       COALESCE((SELECT content FROM summaries WHERE si.id=ANY(evidence_item_ids) AND purpose='item' ORDER BY created_at DESC LIMIT 1),si.body) AS summary,
       COALESCE((SELECT array_agg(label ORDER BY label) FROM classifications WHERE source_item_id=si.id),'{}') AS categories
       FROM delivery_batch_items bi JOIN source_items si ON si.id=bi.source_item_id
       WHERE bi.batch_id=$1 ORDER BY bi.position`,
      [batchId],
    );
    return {
      id: row.id,
      subscriptionId: row.subscription_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      rendererVersion: row.renderer_version,
      state: row.state,
      targets: targets ?? row.channels,
      items: items.rows,
    };
  }

  async getBatch(batchId: string): Promise<FrozenBatch> {
    const client = await this.pool.connect();
    try {
      return await this.loadBatch(client, batchId);
    } finally {
      client.release();
    }
  }

  async beginDelivery(
    batchId: string,
    target: DeliveryTarget,
    rendererVersion: string,
  ): Promise<DeliveryAttemptResult> {
    const key = `${batchId}:${target.channel}:${target.recipientId}:${rendererVersion}`;
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO delivery_attempts (id,batch_id,channel,recipient_id,renderer_version,idempotency_key,status,attempt_count)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',0) ON CONFLICT (idempotency_key) DO NOTHING`,
      [id, batchId, target.channel, target.recipientId, rendererVersion, key],
    );
    const result = await this.pool.query<{
      id: string;
      status: string;
      attempt_count: number;
    }>(
      "SELECT id,status,attempt_count FROM delivery_attempts WHERE idempotency_key=$1",
      [key],
    );
    const row = result.rows[0]!;
    return {
      id: row.id,
      skip: row.status === "success" || row.status === "permanent_failure",
      attempts: row.attempt_count,
    };
  }

  async finishDelivery(
    id: string,
    status: "success" | "temporary_failure" | "permanent_failure",
    providerId?: string,
    error?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE delivery_attempts SET status=$2,provider_id=$3,error_message=$4,attempt_count=attempt_count+1,updated_at=now() WHERE id=$1`,
      [id, status, providerId ?? null, error?.slice(0, 500) ?? null],
    );
  }

  async reconcileBatch(batchId: string): Promise<string> {
    const result = await this.pool.query<{
      total: string;
      success: string;
      failed: string;
    }>(
      `SELECT count(*) AS total,count(*) FILTER (WHERE status='success') AS success,
       count(*) FILTER (WHERE status<>'success') AS failed FROM delivery_attempts WHERE batch_id=$1`,
      [batchId],
    );
    const row = result.rows[0]!;
    const state =
      Number(row.total) > 0 && row.total === row.success
        ? "delivered"
        : Number(row.success) > 0
          ? "partially_failed"
          : "failed";
    await this.pool.query(
      "UPDATE delivery_batches SET state=$2,updated_at=now() WHERE id=$1",
      [batchId, state],
    );
    return state;
  }

  async recordPublication(
    batchId: string,
    visibility: Visibility,
    filePath: string,
    contentHash: string,
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO mdx_publications (id,batch_id,visibility,file_path,content_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (file_path) DO UPDATE SET content_hash=EXCLUDED.content_hash",
      [randomUUID(), batchId, visibility, filePath, contentHash],
    );
  }

  async search(
    query: string,
    limit = 20,
  ): Promise<Array<{ id: string; title: string; url: string }>> {
    const result = await this.pool.query<{
      id: string;
      title: string;
      url: string;
    }>(
      `SELECT id,title,canonical_url AS url FROM source_items
       WHERE to_tsvector('simple',title || ' ' || body) @@ plainto_tsquery('simple',$1)
       ORDER BY collected_at DESC LIMIT $2`,
      [query, limit],
    );
    return result.rows;
  }

  async sourceStatus(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT s.id,s.kind,s.locator,c.last_success_at,c.last_error,COALESCE(c.failure_count,0) AS failure_count
       FROM sources s LEFT JOIN source_cursors c ON c.source_id=s.id ORDER BY s.created_at`,
    );
    return result.rows;
  }

  async collectableSources(): Promise<
    Array<{ id: string; kind: string; locator: string; etag: string | null }>
  > {
    const result = await this.pool.query<{
      id: string;
      kind: string;
      locator: string;
      etag: string | null;
    }>(
      `SELECT s.id,s.kind,s.locator,c.etag FROM sources s
       LEFT JOIN source_cursors c ON c.source_id=s.id
       WHERE s.state='active' AND s.kind IN ('github','rss') ORDER BY s.created_at`,
    );
    return result.rows;
  }

  async activeSubscriptions(): Promise<
    Array<{ id: string; cadence: string; timezone: string }>
  > {
    const result = await this.pool.query<{
      id: string;
      cadence: string;
      timezone: string;
    }>(
      "SELECT id,cadence,timezone FROM subscriptions WHERE active=true ORDER BY created_at",
    );
    return result.rows;
  }

  async activeSourceIds(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM sources WHERE state='active' ORDER BY created_at",
    );
    return result.rows.map((row) => row.id);
  }

  async latestActiveSubscription(ownerId: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM subscriptions WHERE owner_id=$1 AND active=true ORDER BY updated_at DESC LIMIT 1",
      [ownerId],
    );
    return result.rows[0]?.id ?? null;
  }

  async deliveryStatus(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      "SELECT id,state,period_start,period_end FROM delivery_batches ORDER BY created_at DESC LIMIT 20",
    );
    return result.rows;
  }

  async createTask(
    requesterId: string,
    specification: Record<string, unknown>,
    riskLevel: string,
  ): Promise<{ taskId: string; revision: number }> {
    return this.transaction(async (client) => {
      const taskId = randomUUID();
      await client.query(
        "INSERT INTO task_requests (id,requester_id,state,risk_level) VALUES ($1,$2,'awaiting_approval',$3)",
        [taskId, requesterId, riskLevel],
      );
      await client.query(
        "INSERT INTO task_revisions (task_id,revision,specification,change_reason) VALUES ($1,1,$2::jsonb,'initial request')",
        [taskId, JSON.stringify(specification)],
      );
      return { taskId, revision: 1 };
    });
  }

  async reviseTask(
    taskId: string,
    specification: Record<string, unknown>,
  ): Promise<number> {
    return this.transaction(async (client) => {
      const current = await client.query<{ current_revision: number }>(
        "SELECT current_revision FROM task_requests WHERE id=$1 FOR UPDATE",
        [taskId],
      );
      if (!current.rows[0]) throw new Error("Task not found");
      const revision = current.rows[0].current_revision + 1;
      await client.query(
        "INSERT INTO task_revisions (task_id,revision,specification,change_reason) VALUES ($1,$2,$3::jsonb,'request revised')",
        [taskId, revision, JSON.stringify(specification)],
      );
      await client.query(
        "UPDATE task_requests SET current_revision=$2,state='awaiting_approval',updated_at=now() WHERE id=$1",
        [taskId, revision],
      );
      await client.query(
        "UPDATE approvals SET decision='expired',updated_at=now() WHERE task_id=$1 AND decision='approved'",
        [taskId],
      );
      return revision;
    });
  }

  async approveTask(
    taskId: string,
    revision: number,
    approverId: string,
    permissions: string[],
    expiresAt: Date,
    messageRef: string,
  ): Promise<string> {
    return this.transaction(async (client) => {
      const task = await client.query<{
        current_revision: number;
        state: string;
      }>(
        "SELECT current_revision,state FROM task_requests WHERE id=$1 FOR UPDATE",
        [taskId],
      );
      if (
        !task.rows[0] ||
        task.rows[0].current_revision !== revision ||
        task.rows[0].state !== "awaiting_approval"
      )
        throw new Error("Task revision is not awaiting approval");
      const taskRevision = await client.query<{
        specification: Record<string, unknown>;
      }>(
        "SELECT specification FROM task_revisions WHERE task_id=$1 AND revision=$2",
        [taskId, revision],
      );
      const requested = Array.isArray(
        taskRevision.rows[0]?.specification.permissions,
      )
        ? taskRevision.rows[0].specification.permissions.map(String)
        : [];
      const knownPermissions = new Set([
        "repo:read",
        "repo:write",
        "commit:create",
        "push",
        "pull_request:create",
        "deploy",
      ]);
      if (
        permissions.some(
          (permission) =>
            !knownPermissions.has(permission) ||
            !requested.includes(permission),
        )
      )
        throw new Error("Approval permissions exceed the requested task scope");
      const approvalId = randomUUID();
      await client.query(
        "INSERT INTO approvals (id,task_id,task_revision,approver_id,permission_scope,decision,expires_at,discord_message_ref) VALUES ($1,$2,$3,$4,$5::jsonb,'approved',$6,$7)",
        [
          approvalId,
          taskId,
          revision,
          approverId,
          JSON.stringify(permissions),
          expiresAt,
          messageRef,
        ],
      );
      await client.query(
        "UPDATE task_requests SET state='approved',updated_at=now() WHERE id=$1",
        [taskId],
      );
      return approvalId;
    });
  }

  async prepareDispatch(
    taskId: string,
    executor: string,
  ): Promise<{
    attemptId: string;
    specification: Record<string, unknown>;
    idempotencyKey: string;
    existingReceipt: string | null;
  }> {
    return this.transaction(async (client) => {
      const task = await client.query<{
        current_revision: number;
        state: string;
      }>(
        "SELECT current_revision,state FROM task_requests WHERE id=$1 FOR UPDATE",
        [taskId],
      );
      const row = task.rows[0];
      if (!row) throw new Error("Task not found");
      const approval = await client.query<{
        id: string;
        permission_scope: string[];
        expires_at: Date;
      }>(
        "SELECT id,permission_scope,expires_at FROM approvals WHERE task_id=$1 AND task_revision=$2 AND decision='approved' AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
        [taskId, row.current_revision],
      );
      if (!approval.rows[0])
        throw new Error(
          "A valid approval for the current revision is required",
        );
      const revision = await client.query<{
        specification: Record<string, unknown>;
      }>(
        "SELECT specification FROM task_revisions WHERE task_id=$1 AND revision=$2",
        [taskId, row.current_revision],
      );
      const key = `${taskId}:${row.current_revision}:${executor}`;
      const attemptId = randomUUID();
      await client.query(
        `INSERT INTO execution_attempts (id,task_id,task_revision,executor,idempotency_key,state)
         VALUES ($1,$2,$3,$4,$5,'dispatched') ON CONFLICT (idempotency_key) DO NOTHING`,
        [attemptId, taskId, row.current_revision, executor, key],
      );
      const attempt = await client.query<{
        id: string;
        receipt_id: string | null;
      }>(
        "SELECT id,receipt_id FROM execution_attempts WHERE idempotency_key=$1",
        [key],
      );
      await client.query(
        "UPDATE task_requests SET state='dispatched',updated_at=now() WHERE id=$1 AND state='approved'",
        [taskId],
      );
      return {
        attemptId: attempt.rows[0]!.id,
        specification: {
          ...revision.rows[0]!.specification,
          task_id: taskId,
          task_revision: row.current_revision,
          execution_attempt_id: attempt.rows[0]!.id,
          workspace_ref: `omp:${attempt.rows[0]!.id}`,
          approval_id: approval.rows[0]!.id,
          approval_expires_at: approval.rows[0]!.expires_at.toISOString(),
          permissions: approval.rows[0]!.permission_scope,
        },
        idempotencyKey: key,
        existingReceipt: attempt.rows[0]!.receipt_id,
      };
    });
  }

  async recordDispatch(
    attemptId: string,
    receiptId: string,
    accepted: boolean,
    reason?: string,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE execution_attempts SET receipt_id=$2,state=$3,result=$4::jsonb,updated_at=now() WHERE id=$1",
      [
        attemptId,
        receiptId,
        accepted ? "running" : "failed",
        JSON.stringify(reason ? { reason } : {}),
      ],
    );
    await this.pool.query(
      `UPDATE task_requests t SET state=$2,updated_at=now() FROM execution_attempts e
       WHERE e.id=$1 AND t.id=e.task_id`,
      [attemptId, accepted ? "running" : "failed"],
    );
  }

  async applyCallback(
    callbackId: string,
    attemptId: string,
    receiptId: string,
    stateVersion: number,
    state: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const attempt = await client.query<{
        state_version: number;
        task_id: string;
        receipt_id: string | null;
      }>(
        "SELECT state_version,task_id,receipt_id FROM execution_attempts WHERE id=$1 FOR UPDATE",
        [attemptId],
      );
      const row = attempt.rows[0];
      if (!row) throw new Error("Execution attempt not found");
      if (!row.receipt_id || row.receipt_id !== receiptId)
        throw new Error("OMP receipt does not match the execution attempt");
      const applied = stateVersion > row.state_version;
      await client.query(
        "INSERT INTO callback_events (callback_event_id,execution_attempt_id,state_version,payload,applied) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (callback_event_id) DO NOTHING",
        [callbackId, attemptId, stateVersion, JSON.stringify(payload), applied],
      );
      if (!applied) return false;
      await client.query(
        "UPDATE execution_attempts SET state=$2,state_version=$3,result=$4::jsonb,updated_at=now() WHERE id=$1",
        [attemptId, state, stateVersion, JSON.stringify(payload)],
      );
      await client.query(
        "UPDATE task_requests SET state=$2,updated_at=now() WHERE id=$1",
        [row.task_id, state],
      );
      return true;
    });
  }

  async executionOwner(attemptId: string): Promise<string> {
    const result = await this.pool.query<{ requester_id: string }>(
      `SELECT t.requester_id FROM execution_attempts e JOIN task_requests t ON t.id=e.task_id WHERE e.id=$1`,
      [attemptId],
    );
    if (!result.rows[0]) throw new Error("Execution attempt not found");
    return result.rows[0].requester_id;
  }

  async taskState(taskId: string): Promise<string> {
    const result = await this.pool.query<{ state: string }>(
      "SELECT state FROM task_requests WHERE id=$1",
      [taskId],
    );
    if (!result.rows[0]) throw new Error("Task not found");
    return result.rows[0].state;
  }

  async latestAwaitingTask(ownerId: string): Promise<{
    id: string;
    revision: number;
    permissions: string[];
  } | null> {
    const result = await this.pool.query<{
      id: string;
      current_revision: number;
      permissions: string[] | null;
    }>(
      `SELECT t.id,t.current_revision,r.specification->'permissions' AS permissions
       FROM task_requests t JOIN task_revisions r
       ON r.task_id=t.id AND r.revision=t.current_revision
       WHERE t.requester_id=$1 AND t.state='awaiting_approval'
       ORDER BY t.updated_at DESC LIMIT 1`,
      [ownerId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          revision: row.current_revision,
          permissions: Array.isArray(row.permissions)
            ? row.permissions.map(String)
            : [],
        }
      : null;
  }

  async latestCancellableTask(ownerId: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM task_requests WHERE requester_id=$1
       AND state NOT IN ('completed','failed','rejected','expired','cancelled')
       ORDER BY updated_at DESC LIMIT 1`,
      [ownerId],
    );
    return result.rows[0]?.id ?? null;
  }

  async enableChatChannel(
    guildId: string,
    channelId: string,
    enabledBy: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO chat_channels (guild_id,channel_id,enabled_by)
       VALUES ($1,$2,$3) ON CONFLICT (channel_id) DO UPDATE
       SET guild_id=EXCLUDED.guild_id,enabled_by=EXCLUDED.enabled_by,
           enabled=true,updated_at=now()`,
      [guildId, channelId, enabledBy],
    );
  }

  async disableChatChannel(channelId: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE chat_channels SET enabled=false,updated_at=now() WHERE channel_id=$1 AND enabled=true",
      [channelId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async chatChannelEnabled(
    guildId: string,
    channelId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM chat_channels WHERE guild_id=$1 AND channel_id=$2 AND enabled=true",
      [guildId, channelId],
    );
    return Boolean(result.rows[0]);
  }

  async appendChatMessage(input: {
    guildId: string;
    channelId: string;
    discordMessageId?: string;
    authorId: string;
    role: "user" | "assistant";
    content: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO chat_messages
       (id,guild_id,channel_id,discord_message_id,author_id,role,content)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (discord_message_id) DO NOTHING`,
      [
        randomUUID(),
        input.guildId,
        input.channelId,
        input.discordMessageId ?? null,
        input.authorId,
        input.role,
        input.content.slice(0, 20_000),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recentChatMessages(
    channelId: string,
    limit = 12,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const result = await this.pool.query<{
      role: "user" | "assistant";
      content: string;
    }>(
      `SELECT role,content FROM (
         SELECT role,content,created_at FROM chat_messages
         WHERE channel_id=$1 ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at`,
      [channelId, limit],
    );
    return result.rows;
  }

  async cancelTask(taskId: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE task_requests SET state='cancelled',updated_at=now() WHERE id=$1 AND state NOT IN ('completed','failed','rejected','expired','cancelled')",
      [taskId],
    );
    if ((result.rowCount ?? 0) === 0)
      throw new Error("Task cannot be cancelled");
  }
}
