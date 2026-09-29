import { randomUUID } from "node:crypto";
import {
  ASIDE_ADAPTER,
  ASIDE_LOCATOR,
  asideItems,
  asideSnapshotSchema,
} from "@rapi/adapters";
import type { RapiAgent } from "./rapi-agent.js";

export class AsideCollector {
  constructor(private readonly agent: RapiAgent) {}

  async claim(): Promise<{
    sourceId: string;
    token: string;
    adapter: string;
    locator: string;
  } | null> {
    return this.agent.store.transaction(async (client) => {
      // All Aside flows are serial, including independent Macs and manual runs.
      await client.query("SELECT pg_advisory_xact_lock(731552025)");
      const busy =
        await client.query(`SELECT 1 FROM source_cursors c JOIN sources s ON s.id=c.source_id
        WHERE s.kind='aside' AND c.modified_at>now() LIMIT 1`);
      if (busy.rowCount) return null;
      const sources = await client.query<{ id: string }>(
        `SELECT s.id FROM sources s
        LEFT JOIN source_cursors c ON c.source_id=s.id
        WHERE s.kind='aside' AND s.state='active' AND s.locator=$1
          AND s.collection_policy->>'visibility'='private'
          AND s.collection_policy->'aside'->>'adapter'=$2
          AND (c.last_success_at IS NULL OR c.last_success_at<now()-interval '15 minutes')
          AND (c.modified_at IS NULL OR c.modified_at<=now())
          AND (COALESCE(c.failure_count,0)=0 OR c.updated_at<now()-
            (LEAST(1800,30*power(2,LEAST(c.failure_count,6))) * interval '1 second'))
        ORDER BY c.last_success_at NULLS FIRST,s.created_at LIMIT 1 FOR UPDATE OF s`,
        [ASIDE_LOCATOR, ASIDE_ADAPTER],
      );
      const source = sources.rows[0];
      if (!source) return null;
      const token = randomUUID();
      await client.query(
        `INSERT INTO source_cursors(source_id,cursor_value,modified_at)
        VALUES($1,$2,now()+interval '3 minutes') ON CONFLICT(source_id) DO UPDATE
        SET cursor_value=$2,modified_at=now()+interval '3 minutes',updated_at=now()`,
        [source.id, token],
      );
      return {
        sourceId: source.id,
        token,
        adapter: ASIDE_ADAPTER,
        locator: ASIDE_LOCATOR,
      };
    });
  }

  async complete(
    input: unknown,
  ): Promise<{ inserted: number; observed: number }> {
    const snapshot = asideSnapshotSchema.parse(input);
    const captured = new Date(snapshot.collectedAt);
    if (Math.abs(Date.now() - captured.getTime()) > 180_000)
      throw new Error("Aside snapshot is stale");
    return this.agent.store.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(731552025)");
      const bound = await client.query<{
        locator: string;
        collection_policy: Record<string, unknown>;
      }>(
        `SELECT s.locator,s.collection_policy FROM sources s JOIN source_cursors c ON c.source_id=s.id
        WHERE s.id=$1 AND s.kind='aside' AND s.state='active' AND c.cursor_value=$2
          AND c.modified_at>now() FOR UPDATE OF s,c`,
        [snapshot.sourceId, snapshot.token],
      );
      const source = bound.rows[0];
      if (
        !source ||
        source.locator !== ASIDE_LOCATOR ||
        source.collection_policy.visibility !== "private" ||
        (source.collection_policy.aside as { adapter?: string } | undefined)
          ?.adapter !== ASIDE_ADAPTER
      )
        throw new Error("Aside lease or private source policy is unavailable");
      let inserted = 0;
      for (const item of asideItems(snapshot)) {
        const saved = await this.agent.ingestExternalItem(
          snapshot.sourceId,
          item,
          captured,
          client,
        );
        if (saved.inserted) inserted++;
      }
      await client.query(
        `UPDATE source_cursors SET cursor_value=$3,modified_at=NULL,
        last_success_at=now(),last_error=NULL,failure_count=0,updated_at=now()
        WHERE source_id=$1 AND cursor_value=$2`,
        [snapshot.sourceId, snapshot.token, snapshot.collectedAt],
      );
      return { inserted, observed: snapshot.stories.length };
    });
  }

  async fail(sourceId: string, token: string): Promise<void> {
    // Never store browser output/errors: they can contain private page content.
    await this.agent.store.pool.query(
      `UPDATE source_cursors SET modified_at=NULL,
      last_error='Aside browser collection failed',failure_count=failure_count+1,updated_at=now()
      WHERE source_id=$1 AND cursor_value=$2 AND modified_at IS NOT NULL`,
      [sourceId, token],
    );
  }
}
