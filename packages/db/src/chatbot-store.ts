import {
  CHATBOT_CONTEXT_TURNS,
  CHATBOT_TURN_CHARS,
  CHATBOT_TURN_TTL_MS,
  buildPrefixTsQuery,
  rankArchiveDocuments,
  searchTerms,
  type ArchiveDocument,
  type ArchiveHit,
  type ChatTurn,
} from "@rapi/core";
import { PostgresStore } from "./postgres-store.js";

interface DocumentRow {
  key: string;
  kind: ArchiveDocument["kind"];
  title: string;
  summary: string;
  url: string;
  published_at: Date;
}

const toDocument = (row: DocumentRow): ArchiveDocument => ({
  key: row.key,
  kind: row.kind,
  title: row.title,
  summary: row.summary,
  url: row.url,
  publishedAt: row.published_at,
});

// Refreshing is idempotent; a few minutes of staleness is fine for Q&A.
const SYNC_INTERVAL_MS = 5 * 60_000;

/** Archive search and 24-hour thread context for the public chatbot. */
export class ChatbotStore {
  private lastSync = 0;
  constructor(readonly db: PostgresStore) {}

  /** Copies sent learner issues and posted curation items into the archive index. */
  async syncArchive(): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO archive_documents(key,kind,title,summary,url,published_at)
       SELECT 'learner:'||i.id, 'learner', i.title, i.summary, i.url, COALESCE(s.sent_at, s.created_at)
       FROM learner_issue_items i JOIN learner_issues s ON s.id=i.issue_id
       WHERE s.state='sent'
       ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary, url=EXCLUDED.url`,
    );
    await this.db.pool.query(
      `INSERT INTO archive_documents(key,kind,title,summary,url,published_at)
       SELECT 'community:'||p.key, 'community',
         left(COALESCE(NULLIF(trim(p.embeds->0->>'title'),''), p.title),160),
         left(regexp_replace(COALESCE(p.embeds->0->>'description',''),'https://[^[:space:])<>]+','','g'),400),
         COALESCE(p.embeds->0->>'url', substring(p.embeds->0->>'description' from 'https://[^[:space:])<>]+')),
         p.posted_at
       FROM community_posts p
       WHERE p.state='posted' AND COALESCE(NULLIF(trim(p.embeds->0->>'title'),''), p.title) IS NOT NULL
         AND COALESCE(p.embeds->0->>'url', substring(p.embeds->0->>'description' from 'https://[^[:space:])<>]+')) LIKE 'https://%'
       ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary, url=EXCLUDED.url`,
    );
    this.lastSync = Date.now();
  }

  async upsertArchiveDocuments(documents: ArchiveDocument[]): Promise<void> {
    for (const document of documents)
      await this.db.pool.query(
        `INSERT INTO archive_documents(key,kind,title,summary,url,published_at)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary,
          url=EXCLUDED.url, published_at=EXCLUDED.published_at`,
        [
          document.key,
          document.kind,
          document.title,
          document.summary,
          document.url,
          document.publishedAt,
        ],
      );
  }

  /** Full-text candidates (prefix match, so Korean particles still hit), ranked by term coverage. */
  async searchArchive(query: string, limit = 5): Promise<ArchiveHit[]> {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    if (Date.now() - this.lastSync > SYNC_INTERVAL_MS) await this.syncArchive();
    const result = await this.db.pool.query<DocumentRow>(
      `SELECT key,kind,title,summary,url,published_at FROM archive_documents
       WHERE search @@ to_tsquery('simple',$1)
       ORDER BY ts_rank(search,to_tsquery('simple',$1)) DESC, published_at DESC LIMIT 60`,
      [buildPrefixTsQuery(terms)],
    );
    return rankArchiveDocuments(query, result.rows.map(toDocument), limit);
  }

  async learnerSubscription(
    userId: string,
  ): Promise<{ cadence: "daily" | "weekly"; active: boolean } | null> {
    const result = await this.db.pool.query<{
      cadence: "daily" | "weekly";
      opted_out_at: Date | null;
    }>(
      "SELECT cadence,opted_out_at FROM learner_subscriptions WHERE user_id=$1",
      [userId],
    );
    const row = result.rows[0];
    return row
      ? { cadence: row.cadence, active: row.opted_out_at === null }
      : null;
  }

  /** Stores both sides of one exchange; they expire together after 24 hours. */
  async appendTurns(
    scopeKey: string,
    userId: string,
    turns: ChatTurn[],
    now = new Date(),
  ): Promise<void> {
    const expires = new Date(now.getTime() + CHATBOT_TURN_TTL_MS);
    await this.db.transaction(async (client) => {
      for (const turn of turns)
        await client.query(
          `INSERT INTO chatbot_turns(scope_key,user_id,role,content,created_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [
            scopeKey,
            userId,
            turn.role,
            turn.content.slice(0, CHATBOT_TURN_CHARS),
            now,
            expires,
          ],
        );
    });
  }

  /** Only the asking user's own turns in this thread, oldest first, never expired ones. */
  async recentTurns(
    scopeKey: string,
    userId: string,
    limit = CHATBOT_CONTEXT_TURNS,
    now = new Date(),
  ): Promise<ChatTurn[]> {
    const result = await this.db.pool.query<ChatTurn>(
      `SELECT role,content FROM (
         SELECT id,role,content FROM chatbot_turns
         WHERE scope_key=$1 AND user_id=$2 AND expires_at>$4 ORDER BY id DESC LIMIT $3
       ) t ORDER BY id`,
      [scopeKey, userId, limit, now],
    );
    return result.rows;
  }

  async purgeExpiredTurns(now = new Date()): Promise<number> {
    const result = await this.db.pool.query(
      "DELETE FROM chatbot_turns WHERE expires_at<=$1",
      [now],
    );
    return result.rowCount ?? 0;
  }

  async deleteUserTurns(userId: string): Promise<number> {
    const result = await this.db.pool.query(
      "DELETE FROM chatbot_turns WHERE user_id=$1",
      [userId],
    );
    return result.rowCount ?? 0;
  }
}
