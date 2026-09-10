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
import { usageWindow } from "@rapi/core";

interface RawEventResult {
  id: string;
  inserted: boolean;
}

interface DeliveryAttemptResult {
  id: string;
  skip: boolean;
  attempts: number;
}

export type WebhookConnectionKind =
  | "github_inbound"
  | "generic_inbound"
  | "discord_outbound";

export interface WebhookConnection {
  id: string;
  guildId: string;
  name: string;
  kind: WebhookConnectionKind;
  sourceId: string | null;
  destinationKind: "discord_channel" | "discord_webhook" | null;
  destinationId: string | null;
  eventFilters: string[];
  secretCiphertext?: string;
  state: "active" | "disabled";
  lastReceivedAt: Date | null;
  lastError: string | null;
}

export interface WebhookQueueJob {
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface AiUsagePolicy {
  guildId: string;
  userDailyLimit: number;
  userCooldownSeconds: number;
  globalDailyLimit: number;
  globalConcurrency: number;
  timezone: string;
  resetHour: number;
  resetMinute: number;
}

export interface AiUsageReservation {
  accepted: boolean;
  duplicate: boolean;
  reason?: "cooldown" | "user_limit" | "global_limit" | "concurrency";
  remaining: number | null;
  resetAt: Date;
  retryAt?: Date;
}

export interface ManagedDiscordResourceRecord {
  guildId: string;
  resourceType: "role" | "category" | "channel" | "message" | "webhook";
  key: string;
  discordId: string;
  layoutDigest: string;
}

export interface DiscordLayoutPlanRecord {
  id: string;
  guildId: string;
  createdBy: string;
  layoutDigest: string;
  snapshotDigest: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
  appliedAt: Date | null;
}

export class PostgresStore {
  readonly pool: Pool;

  constructor(
    connectionString: string,
    options: {
      max?: number;
      connectionTimeoutMs?: number;
      queryTimeoutMs?: number;
    } = {},
  ) {
    this.pool = new Pool({
      connectionString,
      max: options.max ?? 5,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
      query_timeout: options.queryTimeoutMs ?? 5000,
    });
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
      discord_layout_plans, discord_managed_resources, ai_usage_events, ai_usage_policies,
      webhook_receipts, webhook_connections, subscriptions, summaries, classifications, item_relations, source_items, queue_jobs,
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

  async searchPublic(
    query: string,
    limit = 20,
  ): Promise<Array<{ id: string; title: string; url: string }>> {
    const result = await this.pool.query<{
      id: string;
      title: string;
      url: string;
    }>(
      `SELECT id,title,canonical_url AS url FROM source_items
       WHERE visibility='public'
         AND to_tsvector('simple',title || ' ' || body) @@ plainto_tsquery('simple',$1)
       ORDER BY collected_at DESC LIMIT $2`,
      [query, limit],
    );
    return result.rows;
  }

  async recentPublicItems(
    limit = 20,
    since = new Date(Date.now() - 86_400_000),
  ): Promise<Array<{ title: string; url: string; summary: string }>> {
    const result = await this.pool.query<{
      title: string;
      url: string;
      summary: string;
    }>(
      `SELECT si.title,si.canonical_url AS url,
        COALESCE((SELECT s.content FROM summaries s
          WHERE si.id=ANY(s.evidence_item_ids) AND s.purpose='item'
          ORDER BY s.created_at DESC LIMIT 1),left(si.body,1000)) AS summary
       FROM source_items si
       WHERE si.visibility='public' AND si.collected_at >= $1
       ORDER BY COALESCE(si.published_at,si.collected_at) DESC LIMIT $2`,
      [since, limit],
    );
    return result.rows;
  }

  async sourceStatus(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT s.id,s.kind,s.locator,s.state,c.last_success_at,c.last_error,COALESCE(c.failure_count,0) AS failure_count
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

  async checkHealth(): Promise<{
    latencyMs: number;
    databaseBytes: number;
    clusterDatabaseBytes: number;
  }> {
    const started = performance.now();
    const result = await this.pool.query<{
      bytes: string;
      cluster_bytes: string;
    }>(
      `SELECT pg_database_size(current_database())::text AS bytes,
        (SELECT sum(pg_database_size(datname))::text FROM pg_database) AS cluster_bytes`,
    );
    return {
      latencyMs: Math.round(performance.now() - started),
      databaseBytes: Number(result.rows[0]?.bytes ?? 0),
      clusterDatabaseBytes: Number(result.rows[0]?.cluster_bytes ?? 0),
    };
  }

  async upsertAiUsagePolicy(
    input: Omit<AiUsagePolicy, "guildId"> & {
      guildId: string;
      updatedBy?: string;
    },
  ): Promise<void> {
    // Validate the timezone before persisting a policy that cannot be evaluated.
    usageWindow(new Date(), input.timezone, input.resetHour, input.resetMinute);
    await this.pool.query(
      `INSERT INTO ai_usage_policies
        (guild_id,user_daily_limit,user_cooldown_seconds,global_daily_limit,
         global_concurrency,timezone,reset_hour,reset_minute,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (guild_id) DO UPDATE SET
         user_daily_limit=EXCLUDED.user_daily_limit,
         user_cooldown_seconds=EXCLUDED.user_cooldown_seconds,
         global_daily_limit=EXCLUDED.global_daily_limit,
         global_concurrency=EXCLUDED.global_concurrency,
         timezone=EXCLUDED.timezone,reset_hour=EXCLUDED.reset_hour,
         reset_minute=EXCLUDED.reset_minute,updated_by=EXCLUDED.updated_by,
         updated_at=now()`,
      [
        input.guildId,
        input.userDailyLimit,
        input.userCooldownSeconds,
        input.globalDailyLimit,
        input.globalConcurrency,
        input.timezone,
        input.resetHour,
        input.resetMinute,
        input.updatedBy ?? null,
      ],
    );
  }

  async aiUsagePolicy(guildId: string): Promise<AiUsagePolicy> {
    await this.pool.query(
      `INSERT INTO ai_usage_policies(guild_id) VALUES($1)
       ON CONFLICT (guild_id) DO NOTHING`,
      [guildId],
    );
    const result = await this.pool.query<{
      guild_id: string;
      user_daily_limit: number;
      user_cooldown_seconds: number;
      global_daily_limit: number;
      global_concurrency: number;
      timezone: string;
      reset_hour: number;
      reset_minute: number;
    }>("SELECT * FROM ai_usage_policies WHERE guild_id=$1", [guildId]);
    const row = result.rows[0]!;
    return {
      guildId: row.guild_id,
      userDailyLimit: row.user_daily_limit,
      userCooldownSeconds: row.user_cooldown_seconds,
      globalDailyLimit: row.global_daily_limit,
      globalConcurrency: row.global_concurrency,
      timezone: row.timezone,
      resetHour: row.reset_hour,
      resetMinute: row.reset_minute,
    };
  }

  async reserveAiUsage(input: {
    guildId: string;
    userId: string;
    requestId: string;
    tier: "user" | "staff";
    requestDigest?: string;
    model?: string;
    now?: Date;
  }): Promise<AiUsageReservation> {
    const now = input.now ?? new Date();
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO ai_usage_policies(guild_id) VALUES($1)
         ON CONFLICT (guild_id) DO NOTHING`,
        [input.guildId],
      );
      const policyResult = await client.query<{
        user_daily_limit: number;
        user_cooldown_seconds: number;
        global_daily_limit: number;
        global_concurrency: number;
        timezone: string;
        reset_hour: number;
        reset_minute: number;
      }>("SELECT * FROM ai_usage_policies WHERE guild_id=$1 FOR UPDATE", [
        input.guildId,
      ]);
      const policy = policyResult.rows[0]!;
      const window = usageWindow(
        now,
        policy.timezone,
        policy.reset_hour,
        policy.reset_minute,
      );
      await client.query(
        `UPDATE ai_usage_events SET
           state=CASE WHEN state='reserved' THEN 'released' ELSE 'failed' END,
           finished_at=$2,updated_at=$2,error_code='stale_reservation'
         WHERE guild_id=$1 AND state IN ('reserved','started')
           AND reserved_at < $2::timestamptz - interval '2 minutes'`,
        [input.guildId, now],
      );
      const existing = await client.query<{ state: string }>(
        `SELECT state FROM ai_usage_events WHERE guild_id=$1 AND request_id=$2`,
        [input.guildId, input.requestId],
      );
      if (existing.rows[0]) {
        const status = await this.aiUsageStatusWithClient(
          client,
          input.guildId,
          input.userId,
          now,
          policy,
        );
        return {
          accepted: existing.rows[0].state !== "released",
          duplicate: true,
          remaining: input.tier === "staff" ? null : status.remaining,
          resetAt: window.endsAt,
        };
      }
      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ai_usage_events
         WHERE guild_id=$1 AND state IN ('reserved','started')`,
        [input.guildId],
      );
      if (Number(active.rows[0]?.count ?? 0) >= policy.global_concurrency)
        return {
          accepted: false,
          duplicate: false,
          reason: "concurrency",
          remaining: input.tier === "staff" ? null : 0,
          resetAt: window.endsAt,
        };
      const usage = await this.aiUsageStatusWithClient(
        client,
        input.guildId,
        input.userId,
        now,
        policy,
      );
      if (input.tier === "user") {
        if (usage.lastUsedAt) {
          const retryAt = new Date(
            usage.lastUsedAt.getTime() + policy.user_cooldown_seconds * 1_000,
          );
          if (retryAt > now)
            return {
              accepted: false,
              duplicate: false,
              reason: "cooldown",
              remaining: usage.remaining,
              resetAt: window.endsAt,
              retryAt,
            };
        }
        if (usage.used >= policy.user_daily_limit)
          return {
            accepted: false,
            duplicate: false,
            reason: "user_limit",
            remaining: 0,
            resetAt: window.endsAt,
          };
        if (usage.globalUsed >= policy.global_daily_limit)
          return {
            accepted: false,
            duplicate: false,
            reason: "global_limit",
            remaining: Math.max(0, policy.user_daily_limit - usage.used),
            resetAt: window.endsAt,
          };
      }
      await client.query(
        `INSERT INTO ai_usage_events
          (id,guild_id,user_id,request_id,tier,state,window_start,window_end,reserved_at,request_digest,model)
         VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9,$10)`,
        [
          randomUUID(),
          input.guildId,
          input.userId,
          input.requestId,
          input.tier,
          window.startsAt,
          window.endsAt,
          now,
          input.requestDigest ?? "",
          input.model ?? "gpt-5.3-codex-spark",
        ],
      );
      return {
        accepted: true,
        duplicate: false,
        remaining:
          input.tier === "staff"
            ? null
            : Math.max(0, policy.user_daily_limit - usage.used - 1),
        resetAt: window.endsAt,
      };
    });
  }

  private async aiUsageStatusWithClient(
    client: PoolClient,
    guildId: string,
    userId: string,
    now: Date,
    policy: {
      user_daily_limit: number;
      global_daily_limit: number;
      timezone: string;
      reset_hour: number;
      reset_minute: number;
    },
  ): Promise<{
    used: number;
    globalUsed: number;
    remaining: number;
    lastUsedAt: Date | null;
  }> {
    const window = usageWindow(
      now,
      policy.timezone,
      policy.reset_hour,
      policy.reset_minute,
    );
    const result = await client.query<{
      used: string;
      global_used: string;
      last_used_at: Date | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE user_id=$2 AND tier='user')::text AS used,
         count(*) FILTER (WHERE tier='user')::text AS global_used,
         max(reserved_at) FILTER (WHERE user_id=$2 AND tier='user') AS last_used_at
       FROM ai_usage_events
       WHERE guild_id=$1 AND window_start=$3 AND state<>'released'`,
      [guildId, userId, window.startsAt],
    );
    const used = Number(result.rows[0]?.used ?? 0);
    return {
      used,
      globalUsed: Number(result.rows[0]?.global_used ?? 0),
      remaining: Math.max(0, policy.user_daily_limit - used),
      lastUsedAt: result.rows[0]?.last_used_at ?? null,
    };
  }

  async markAiUsageStarted(requestId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ai_usage_events SET state='started',started_at=now(),updated_at=now()
       WHERE request_id=$1 AND state='reserved'`,
      [requestId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async finishAiUsage(
    requestId: string,
    state: "succeeded" | "failed",
    errorCode?: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ai_usage_events SET state=$2,finished_at=now(),updated_at=now(),error_code=$3
       WHERE request_id=$1 AND state IN ('reserved','started')`,
      [requestId, state, errorCode?.slice(0, 100) ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseAiUsage(requestId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ai_usage_events SET state='released',finished_at=now(),updated_at=now()
       WHERE request_id=$1 AND state='reserved'`,
      [requestId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async aiUsageStatus(
    guildId: string,
    userId: string,
    now = new Date(),
  ): Promise<{
    used: number;
    remaining: number;
    globalUsed: number;
    globalRemaining: number;
    resetAt: Date;
  }> {
    const policy = await this.aiUsagePolicy(guildId);
    const client = await this.pool.connect();
    try {
      const status = await this.aiUsageStatusWithClient(
        client,
        guildId,
        userId,
        now,
        {
          user_daily_limit: policy.userDailyLimit,
          global_daily_limit: policy.globalDailyLimit,
          timezone: policy.timezone,
          reset_hour: policy.resetHour,
          reset_minute: policy.resetMinute,
        },
      );
      const window = usageWindow(
        now,
        policy.timezone,
        policy.resetHour,
        policy.resetMinute,
      );
      return {
        used: status.used,
        remaining: status.remaining,
        globalUsed: status.globalUsed,
        globalRemaining: Math.max(
          0,
          policy.globalDailyLimit - status.globalUsed,
        ),
        resetAt: window.endsAt,
      };
    } finally {
      client.release();
    }
  }

  async managedDiscordResourceId(
    guildId: string,
    resourceType: "role" | "category" | "channel" | "message" | "webhook",
    key: string,
  ): Promise<string | null> {
    const result = await this.pool.query<{ discord_id: string }>(
      `SELECT discord_id FROM discord_managed_resources
       WHERE guild_id=$1 AND resource_type=$2 AND resource_key=$3`,
      [guildId, resourceType, key],
    );
    return result.rows[0]?.discord_id ?? null;
  }

  async listManagedDiscordResources(
    guildId: string,
  ): Promise<ManagedDiscordResourceRecord[]> {
    const result = await this.pool.query<{
      guild_id: string;
      resource_type: ManagedDiscordResourceRecord["resourceType"];
      resource_key: string;
      discord_id: string;
      last_applied_digest: string;
    }>(
      `SELECT guild_id,resource_type,resource_key,discord_id,last_applied_digest
       FROM discord_managed_resources WHERE guild_id=$1
       ORDER BY resource_type,resource_key`,
      [guildId],
    );
    return result.rows.map((row) => ({
      guildId: row.guild_id,
      resourceType: row.resource_type,
      key: row.resource_key,
      discordId: row.discord_id,
      layoutDigest: row.last_applied_digest,
    }));
  }

  async upsertManagedDiscordResource(input: {
    guildId: string;
    resourceType: ManagedDiscordResourceRecord["resourceType"];
    key: string;
    discordId: string;
    layoutDigest: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO discord_managed_resources
        (guild_id,resource_type,resource_key,discord_id,last_applied_digest)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (guild_id,resource_type,resource_key) DO UPDATE SET
         discord_id=EXCLUDED.discord_id,
         last_applied_digest=EXCLUDED.last_applied_digest,updated_at=now()`,
      [
        input.guildId,
        input.resourceType,
        input.key,
        input.discordId,
        input.layoutDigest,
      ],
    );
  }

  async removeManagedDiscordResource(
    guildId: string,
    resourceType: ManagedDiscordResourceRecord["resourceType"],
    discordId: string,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM discord_managed_resources
       WHERE guild_id=$1 AND resource_type=$2 AND discord_id=$3`,
      [guildId, resourceType, discordId],
    );
  }

  async createDiscordLayoutPlan(input: {
    guildId: string;
    createdBy: string;
    layoutDigest: string;
    snapshotDigest: string;
    payload: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO discord_layout_plans
        (id,guild_id,created_by,layout_digest,snapshot_digest,actions,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        id,
        input.guildId,
        input.createdBy,
        input.layoutDigest,
        input.snapshotDigest,
        JSON.stringify(input.payload),
        input.expiresAt,
      ],
    );
    return id;
  }

  async discordLayoutPlan(
    guildId: string,
    id: string,
  ): Promise<DiscordLayoutPlanRecord | null> {
    const result = await this.pool.query<{
      id: string;
      guild_id: string;
      created_by: string;
      layout_digest: string;
      snapshot_digest: string;
      actions: Record<string, unknown>;
      expires_at: Date;
      applied_at: Date | null;
    }>(
      `SELECT id,guild_id,created_by,layout_digest,snapshot_digest,actions,
              expires_at,applied_at
       FROM discord_layout_plans WHERE guild_id=$1 AND id=$2`,
      [guildId, id],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          guildId: row.guild_id,
          createdBy: row.created_by,
          layoutDigest: row.layout_digest,
          snapshotDigest: row.snapshot_digest,
          payload: row.actions,
          expiresAt: row.expires_at,
          appliedAt: row.applied_at,
        }
      : null;
  }

  async markDiscordLayoutPlanApplied(
    guildId: string,
    id: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discord_layout_plans SET applied_at=now()
       WHERE guild_id=$1 AND id=$2 AND applied_at IS NULL AND expires_at>now()`,
      [guildId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async claimDiscordLayoutPlan(guildId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discord_layout_plans SET apply_started_at=now()
       WHERE guild_id=$1 AND id=$2 AND applied_at IS NULL
         AND apply_started_at IS NULL AND expires_at>now()`,
      [guildId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseDiscordLayoutPlanClaim(
    guildId: string,
    id: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE discord_layout_plans SET apply_started_at=NULL
       WHERE guild_id=$1 AND id=$2 AND applied_at IS NULL`,
      [guildId, id],
    );
  }

  async createWebhookConnection(input: {
    guildId: string;
    name: string;
    kind: WebhookConnectionKind;
    destinationKind?: "discord_channel" | "discord_webhook";
    destinationId?: string;
    eventFilters: string[];
    secretCiphertext: string;
  }): Promise<{ id: string; sourceId: string | null }> {
    return this.transaction(async (client) => {
      const id = randomUUID();
      let sourceId: string | null = null;
      if (input.kind !== "discord_outbound") {
        sourceId = randomUUID();
        await client.query(
          `INSERT INTO sources (id,kind,locator,collection_policy)
           VALUES ($1,'webhook',$2,jsonb_build_object('visibility','private'))`,
          [sourceId, `managed://${id}`],
        );
      }
      const result = await client.query<{
        id: string;
        source_id: string | null;
      }>(
        `INSERT INTO webhook_connections
          (id,guild_id,name,kind,source_id,destination_kind,destination_id,event_filters,secret_ciphertext)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id,source_id`,
        [
          id,
          input.guildId,
          input.name,
          input.kind,
          sourceId,
          input.destinationKind ?? null,
          input.destinationId ?? null,
          input.eventFilters,
          input.secretCiphertext,
        ],
      );
      return {
        id: result.rows[0]!.id,
        sourceId: result.rows[0]!.source_id,
      };
    });
  }

  async listWebhookConnections(
    guildId: string,
    includeSecrets = false,
  ): Promise<WebhookConnection[]> {
    const result = await this.pool.query<{
      id: string;
      guild_id: string;
      name: string;
      kind: WebhookConnectionKind;
      source_id: string | null;
      destination_kind: "discord_channel" | "discord_webhook" | null;
      destination_id: string | null;
      event_filters: string[];
      secret_ciphertext: string;
      state: "active" | "disabled";
      last_received_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT id,guild_id,name,kind,source_id,destination_kind,destination_id,event_filters,
              secret_ciphertext,state,last_received_at,last_error
       FROM webhook_connections WHERE guild_id=$1 ORDER BY created_at`,
      [guildId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      guildId: row.guild_id,
      name: row.name,
      kind: row.kind,
      sourceId: row.source_id,
      destinationKind: row.destination_kind,
      destinationId: row.destination_id,
      eventFilters: row.event_filters,
      ...(includeSecrets ? { secretCiphertext: row.secret_ciphertext } : {}),
      state: row.state,
      lastReceivedAt: row.last_received_at,
      lastError: row.last_error,
    }));
  }

  async getWebhookConnection(
    connectionId: string,
    includeSecret = false,
  ): Promise<WebhookConnection | null> {
    const result = await this.pool.query<{ guild_id: string }>(
      "SELECT guild_id FROM webhook_connections WHERE id=$1",
      [connectionId],
    );
    if (!result.rows[0]) return null;
    const connections = await this.listWebhookConnections(
      result.rows[0].guild_id,
      includeSecret,
    );
    return (
      connections.find((connection) => connection.id === connectionId) ?? null
    );
  }

  async setWebhookConnectionState(
    guildId: string,
    id: string,
    state: "active" | "disabled",
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE webhook_connections SET state=$3,updated_at=now()
       WHERE id=$1 AND guild_id=$2 AND state<>$3`,
      [id, guildId, state],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async webhookConnectionByName(
    guildId: string,
    name: string,
    includeSecret = false,
  ): Promise<WebhookConnection | null> {
    const connections = await this.listWebhookConnections(
      guildId,
      includeSecret,
    );
    return connections.find((connection) => connection.name === name) ?? null;
  }

  async ingestManagedWebhook(input: {
    connectionId: string;
    deliveryId: string;
    eventType: string;
    payloadHash: string;
    rawPayload: Record<string, unknown>;
    item: NormalizedItem;
    summary: string;
  }): Promise<{ inserted: boolean; itemId?: string }> {
    return this.transaction(async (client) => {
      const connection = await client.query<{
        source_id: string;
        destination_kind: string;
        destination_id: string;
        event_filters: string[];
        state: string;
      }>(
        `SELECT source_id,destination_kind,destination_id,event_filters,state
         FROM webhook_connections WHERE id=$1 FOR UPDATE`,
        [input.connectionId],
      );
      const target = connection.rows[0];
      if (!target || target.state !== "active" || !target.source_id)
        throw new Error("Webhook connection is not active");
      if (
        target.event_filters.length > 0 &&
        !target.event_filters.includes(input.eventType)
      )
        throw new Error("Webhook event type is not allowed");
      const existing = await client.query<{
        payload_hash: string;
        source_item_id: string | null;
      }>(
        `SELECT payload_hash,source_item_id FROM webhook_receipts
         WHERE connection_id=$1 AND external_event_id=$2`,
        [input.connectionId, input.deliveryId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== input.payloadHash)
          throw new Error("Webhook delivery ID has a conflicting payload");
        return {
          inserted: false,
          ...(existing.rows[0].source_item_id
            ? { itemId: existing.rows[0].source_item_id }
            : {}),
        };
      }
      await client.query(
        `INSERT INTO raw_events
          (id,source_id,external_event_id,canonical_payload_hash,payload,collected_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          input.item.rawEventId,
          target.source_id,
          input.deliveryId,
          input.payloadHash,
          JSON.stringify(input.rawPayload),
          input.item.collectedAt,
        ],
      );
      await client.query(
        `INSERT INTO source_items
          (id,raw_event_id,normalizer_version,canonical_url,title,body,author,published_at,
           collected_at,visibility,content_fingerprint,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          input.item.id,
          input.item.rawEventId,
          input.item.normalizerVersion,
          input.item.canonicalUrl,
          input.item.title,
          input.item.body,
          input.item.author,
          input.item.publishedAt,
          input.item.collectedAt,
          input.item.visibility,
          input.item.contentFingerprint,
          JSON.stringify({
            ...input.item.metadata,
            sourceId: target.source_id,
          }),
        ],
      );
      for (const category of input.item.categories)
        await client.query(
          `INSERT INTO classifications
            (id,source_item_id,taxonomy_version,label,score,evidence)
           VALUES ($1,$2,'rules-v1',$3,1,'deterministic keyword rule')`,
          [randomUUID(), input.item.id, category],
        );
      await client.query(
        `INSERT INTO summaries
          (id,purpose,cache_key,model_policy_version,prompt_version,content,evidence_item_ids)
         VALUES ($1,'item',$2,'rules-v1','summary-v1',$3,$4::uuid[])`,
        [
          randomUUID(),
          `${input.item.id}:item:rules-v1:summary-v1`,
          input.summary,
          [input.item.id],
        ],
      );
      await client.query(
        `INSERT INTO webhook_receipts
          (id,connection_id,external_event_id,payload_hash,event_type,source_item_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          input.connectionId,
          input.deliveryId,
          input.payloadHash,
          input.eventType,
          input.item.id,
        ],
      );
      await client.query(
        `INSERT INTO queue_jobs (id,kind,payload,state,idempotency_key)
         VALUES ($1,'webhook_delivery',$2::jsonb,'ready',$3)`,
        [
          randomUUID(),
          JSON.stringify({
            sourceConnectionId: input.connectionId,
            destinationKind: target.destination_kind,
            destinationId: target.destination_id,
            itemId: input.item.id,
            title: input.item.title,
            summary: input.summary,
            url: input.item.canonicalUrl,
            sentChunks: 0,
          }),
          `webhook:${input.connectionId}:${input.deliveryId}`,
        ],
      );
      await client.query(
        `UPDATE webhook_connections SET last_received_at=now(),last_error=NULL,updated_at=now()
         WHERE id=$1`,
        [input.connectionId],
      );
      return { inserted: true, itemId: input.item.id };
    });
  }

  async enqueueWebhookJob(
    idempotencyKey: string,
    payload: Record<string, unknown>,
    maxAttempts = 5,
  ): Promise<string> {
    const id = randomUUID();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO queue_jobs (id,kind,payload,state,max_attempts,idempotency_key)
       VALUES ($1,'webhook_delivery',$2::jsonb,'ready',$3,$4)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
       RETURNING id`,
      [id, JSON.stringify(payload), maxAttempts, idempotencyKey],
    );
    return result.rows[0]!.id;
  }

  async leaseWebhookJobs(
    limit: number,
    leaseMs: number,
  ): Promise<WebhookQueueJob[]> {
    const result = await this.pool.query<{
      id: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(
      `WITH candidates AS (
         SELECT id FROM queue_jobs
         WHERE kind='webhook_delivery'
           AND attempts < max_attempts
           AND available_at <= now()
           AND (state='ready' OR (state='leased' AND lease_expires_at <= now()))
         ORDER BY available_at,created_at
         FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE queue_jobs q SET state='leased',lease_expires_at=now()+($2 * interval '1 millisecond'),updated_at=now()
       FROM candidates WHERE q.id=candidates.id
       RETURNING q.id,q.payload,q.attempts,q.max_attempts`,
      [limit, leaseMs],
    );
    return result.rows.map((row) => ({
      id: row.id,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  }

  async updateWebhookJobProgress(
    id: string,
    sentChunks: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE queue_jobs SET payload=jsonb_set(payload,'{sentChunks}',to_jsonb($2::int)),updated_at=now()
       WHERE id=$1 AND state='leased'`,
      [id, sentChunks],
    );
  }

  async completeWebhookJob(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE queue_jobs SET state='done',lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND state='leased'`,
      [id],
    );
  }

  async releaseWebhookJob(id: string, delayMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE queue_jobs SET state='ready',available_at=now()+($2 * interval '1 millisecond'),
       lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND state='leased'`,
      [id, delayMs],
    );
  }

  async failWebhookJob(
    id: string,
    error: string,
    delayMs: number,
    retryable: boolean,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE queue_jobs SET
         attempts=attempts+1,
         state=CASE WHEN $4 AND attempts+1 < max_attempts THEN 'ready' ELSE 'dead_letter' END,
         available_at=CASE WHEN $4 THEN now()+($3 * interval '1 millisecond') ELSE available_at END,
         lease_expires_at=NULL,last_error=$2,updated_at=now()
       WHERE id=$1 AND state='leased'`,
      [id, error.slice(0, 500), delayMs, retryable],
    );
  }

  async webhookQueueStatus(): Promise<{
    ready: number;
    leased: number;
    done: number;
    deadLetter: number;
  }> {
    const result = await this.pool.query<{ state: string; count: string }>(
      `SELECT state,count(*)::text AS count FROM queue_jobs
       WHERE kind='webhook_delivery' GROUP BY state`,
    );
    const counts = Object.fromEntries(
      result.rows.map((row) => [row.state, Number(row.count)]),
    );
    return {
      ready: counts.ready ?? 0,
      leased: counts.leased ?? 0,
      done: counts.done ?? 0,
      deadLetter: counts.dead_letter ?? 0,
    };
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
