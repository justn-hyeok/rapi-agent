import type { PostgresStore } from "./postgres-store.js";

export interface WebAccountRecord {
  userId: string;
  username: string;
  displayName: string | null;
}

export interface WebLearnerSubscription {
  cadence: "daily" | "weekly";
  active: boolean;
}

export interface WebArchiveIssue {
  slug: string;
  cadence: "daily" | "weekly";
  periodKey: string;
  sentAt: Date;
  items: Array<{
    section: "core" | "tools";
    title: string;
    summary: string;
    url: string;
  }>;
}

/** Slugs are `<cadence>-<period key>`; the unique pair identifies one issue. */
export function archiveSlug(cadence: string, periodKey: string): string {
  return `${cadence}-${periodKey}`;
}

export function parseArchiveSlug(
  slug: string,
): { cadence: "daily" | "weekly"; periodKey: string } | null {
  const match = /^(daily|weekly)-(\d{4}-\d{2}-\d{2})$/.exec(slug);
  return match
    ? {
        cadence: match[1] as "daily" | "weekly",
        periodKey: match[2]!,
      }
    : null;
}

/**
 * Web accounts, sessions and the read-only learner queries the web needs.
 * Subscription writes go through the learner store methods on
 * {@link PostgresStore}, so Discord buttons and the web share the same rows.
 */
export class WebStore {
  constructor(private readonly db: PostgresStore) {}

  async upsertAccount(
    input: WebAccountRecord,
    now: Date,
  ): Promise<WebAccountRecord> {
    await this.db.pool.query(
      `INSERT INTO web_accounts(discord_user_id,username,display_name,created_at,last_login_at)
       VALUES($1,$2,$3,$4,$4)
       ON CONFLICT (discord_user_id) DO UPDATE SET username=$2,display_name=$3,last_login_at=$4`,
      [input.userId, input.username, input.displayName, now],
    );
    return input;
  }

  async createSession(
    idHash: string,
    userId: string,
    now: Date,
    expiresAt: Date,
  ): Promise<void> {
    await this.db.pool.query(
      "DELETE FROM web_sessions WHERE expires_at <= $1",
      [now],
    );
    await this.db.pool.query(
      "INSERT INTO web_sessions(id_hash,discord_user_id,created_at,expires_at) VALUES($1,$2,$3,$4)",
      [idHash, userId, now, expiresAt],
    );
  }

  async sessionAccount(
    idHash: string,
    now: Date,
  ): Promise<WebAccountRecord | null> {
    const result = await this.db.pool.query<{
      discord_user_id: string;
      username: string;
      display_name: string | null;
    }>(
      `SELECT a.discord_user_id,a.username,a.display_name FROM web_sessions s
       JOIN web_accounts a ON a.discord_user_id=s.discord_user_id
       WHERE s.id_hash=$1 AND s.expires_at > $2`,
      [idHash, now],
    );
    const row = result.rows[0];
    return row
      ? {
          userId: row.discord_user_id,
          username: row.username,
          displayName: row.display_name,
        }
      : null;
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.db.pool.query("DELETE FROM web_sessions WHERE id_hash=$1", [
      idHash,
    ]);
  }

  async learnerSubscription(
    userId: string,
  ): Promise<WebLearnerSubscription | null> {
    const result = await this.db.pool.query<{
      cadence: "daily" | "weekly";
      active: boolean;
    }>(
      "SELECT cadence, opted_out_at IS NULL AS active FROM learner_subscriptions WHERE user_id=$1",
      [userId],
    );
    return result.rows[0] ?? null;
  }

  /** Sent learner issues, newest first. Items are loaded only for the single-issue view. */
  async archiveIssues(limit: number): Promise<WebArchiveIssue[]> {
    const result = await this.db.pool.query<{
      cadence: "daily" | "weekly";
      period_key: string;
      sent_at: Date;
    }>(
      `SELECT cadence,period_key,sent_at FROM learner_issues
       WHERE state='sent' AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      slug: archiveSlug(row.cadence, row.period_key),
      cadence: row.cadence,
      periodKey: row.period_key,
      sentAt: row.sent_at,
      items: [],
    }));
  }

  async archiveIssue(slug: string): Promise<WebArchiveIssue | null> {
    const parsed = parseArchiveSlug(slug);
    if (!parsed) return null;
    const issue = await this.db.pool.query<{ id: string; sent_at: Date }>(
      `SELECT id,sent_at FROM learner_issues
       WHERE state='sent' AND sent_at IS NOT NULL AND cadence=$1 AND period_key=$2`,
      [parsed.cadence, parsed.periodKey],
    );
    const row = issue.rows[0];
    if (!row) return null;
    const items = await this.db.pool.query<{
      section: "core" | "tools";
      title: string;
      summary: string;
      url: string;
    }>(
      "SELECT section,title,summary,url FROM learner_issue_items WHERE issue_id=$1 ORDER BY position",
      [row.id],
    );
    return {
      slug,
      cadence: parsed.cadence,
      periodKey: parsed.periodKey,
      sentAt: row.sent_at,
      items: items.rows,
    };
  }
}
