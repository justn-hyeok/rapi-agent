import { randomUUID } from "node:crypto";
import { EMAIL_SOFT_BOUNCE_LIMIT, type EmailSuppressionKind } from "@rapi/core";
import type { PostgresStore } from "./postgres-store.js";

export type EmailBounceState = "none" | "soft" | "hard" | "complaint";

export interface EmailAddressRecord {
  id: string;
  userId: string;
  email: string;
  verified: boolean;
  unsubscribed: boolean;
  bounceState: EmailBounceState;
}

export interface EmailRecipient {
  emailId: string;
  userId: string;
  email: string;
}

interface Row {
  id: string;
  user_id: string;
  email: string;
  verified_at: Date | null;
  unsubscribed_at: Date | null;
  bounce_state: EmailBounceState;
}

const COLUMNS = "id,user_id,email,verified_at,unsubscribed_at,bounce_state";

function record(row: Row): EmailAddressRecord {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    verified: row.verified_at !== null,
    unsubscribed: row.unsubscribed_at !== null,
    bounceState: row.bounce_state,
  };
}

/** Learner email addresses, verification state, suppression and per-recipient delivery results. */
export class EmailStore {
  constructor(private readonly db: PostgresStore) {}

  /**
   * Stores an address for the learner. The same address keeps its row (and
   * state); a different one replaces it with a new id, so links and delivery
   * results of the old address die with it.
   */
  async register(userId: string, email: string): Promise<EmailAddressRecord> {
    await this.db.pool.query(
      "DELETE FROM learner_emails WHERE user_id=$1 AND lower(email)<>lower($2)",
      [userId, email],
    );
    const result = await this.db.pool.query<Row>(
      `INSERT INTO learner_emails(id,user_id,email) VALUES($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET unsubscribed_at=NULL
       RETURNING ${COLUMNS}`,
      [randomUUID(), userId, email],
    );
    return record(result.rows[0]!);
  }

  async byUser(userId: string): Promise<EmailAddressRecord | null> {
    const result = await this.db.pool.query<Row>(
      `SELECT ${COLUMNS} FROM learner_emails WHERE user_id=$1`,
      [userId],
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  async byId(id: string): Promise<EmailAddressRecord | null> {
    const result = await this.db.pool.query<Row>(
      `SELECT ${COLUMNS} FROM learner_emails WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  /**
   * Claims the right to send one verification mail: not within the cooldown
   * for this row, and not while another learner's request for the same
   * address is that fresh (stops using the bot to mail strangers).
   */
  async claimVerificationSend(
    id: string,
    now: Date,
    cooldownMs: number,
  ): Promise<boolean> {
    const since = new Date(now.getTime() - cooldownMs);
    const result = await this.db.pool.query(
      `UPDATE learner_emails e SET verification_sent_at=$2
       WHERE e.id=$1 AND (e.verification_sent_at IS NULL OR e.verification_sent_at<$3)
        AND NOT EXISTS (SELECT 1 FROM learner_emails o WHERE o.id<>e.id AND lower(o.email)=lower(e.email) AND o.verification_sent_at>=$3)`,
      [id, now, since],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Single use: only the call that flips `verified_at` from NULL wins. */
  async verify(id: string): Promise<"verified" | "already" | "missing"> {
    const result = await this.db.pool.query(
      "UPDATE learner_emails SET verified_at=now(),unsubscribed_at=NULL WHERE id=$1 AND verified_at IS NULL",
      [id],
    );
    if (result.rowCount) return "verified";
    return (await this.byId(id)) ? "already" : "missing";
  }

  async unsubscribe(id: string): Promise<boolean> {
    const result = await this.db.pool.query(
      "UPDATE learner_emails SET unsubscribed_at=COALESCE(unsubscribed_at,now()) WHERE id=$1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Hard bounces and complaints stop sending; soft ones only count towards the limit. */
  async suppress(email: string, kind: EmailSuppressionKind): Promise<number> {
    const result =
      kind === "soft"
        ? await this.db.pool.query(
            `UPDATE learner_emails SET soft_bounce_count=soft_bounce_count+1,bounced_at=now(),
              bounce_state=CASE WHEN bounce_state IN ('hard','complaint') THEN bounce_state
               WHEN soft_bounce_count+1>=$2 THEN 'hard' ELSE 'soft' END
             WHERE lower(email)=lower($1)`,
            [email, EMAIL_SOFT_BOUNCE_LIMIT],
          )
        : await this.db.pool.query(
            `UPDATE learner_emails SET bounced_at=now(),
              bounce_state=CASE WHEN bounce_state='complaint' THEN 'complaint' ELSE $2::text END
             WHERE lower(email)=lower($1)`,
            [email, kind === "hard" ? "hard" : "complaint"],
          );
    return result.rowCount ?? 0;
  }

  /** Active learners of the cadence with a verified, deliverable address that this issue has not tried yet. */
  async recipients(
    cadence: "daily" | "weekly",
    issueId: string,
  ): Promise<EmailRecipient[]> {
    const result = await this.db.pool.query<{
      id: string;
      user_id: string;
      email: string;
    }>(
      `SELECT e.id,e.user_id,e.email FROM learner_emails e
       JOIN learner_subscriptions s ON s.user_id=e.user_id
       WHERE s.cadence=$1 AND s.opted_out_at IS NULL
        AND e.verified_at IS NOT NULL AND e.unsubscribed_at IS NULL
        AND e.bounce_state IN ('none','soft')
        AND NOT EXISTS (SELECT 1 FROM learner_email_deliveries d WHERE d.issue_id=$2 AND d.email_id=e.id)
       ORDER BY e.created_at`,
      [cadence, issueId],
    );
    return result.rows.map((row) => ({
      emailId: row.id,
      userId: row.user_id,
      email: row.email,
    }));
  }

  /** At most once: a crash after the claim leaves `pending`, which is never retried. */
  async claimDelivery(issueId: string, emailId: string): Promise<boolean> {
    const result = await this.db.pool.query(
      `INSERT INTO learner_email_deliveries(issue_id,email_id,state) VALUES($1,$2,'pending')
       ON CONFLICT DO NOTHING`,
      [issueId, emailId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async finishDelivery(input: {
    issueId: string;
    emailId: string;
    state: "sent" | "failed";
    providerId?: string;
    error?: string;
  }): Promise<void> {
    await this.db.pool.query(
      `UPDATE learner_email_deliveries SET state=$3,provider_id=$4,error=$5,at=now()
       WHERE issue_id=$1 AND email_id=$2`,
      [
        input.issueId,
        input.emailId,
        input.state,
        input.providerId ?? null,
        input.error ?? null,
      ],
    );
  }

  async deliveryCounts(
    issueId: string,
  ): Promise<{ sent: number; failed: number }> {
    const result = await this.db.pool.query<{ state: string; n: string }>(
      "SELECT state,count(*) AS n FROM learner_email_deliveries WHERE issue_id=$1 GROUP BY state",
      [issueId],
    );
    const count = (state: string) =>
      Number(result.rows.find((row) => row.state === state)?.n ?? 0);
    return { sent: count("sent"), failed: count("failed") };
  }
}
