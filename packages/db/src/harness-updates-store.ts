import { randomUUID } from "node:crypto";
import type { PostgresStore } from "./postgres-store.js";

export type HarnessUpdateState =
  | "pending_evaluation"
  | "notified"
  | "applying"
  | "pr_open"
  | "merged"
  | "reverting"
  | "revert_pr_open"
  | "reverted"
  | "skipped"
  | "failed";

export interface HarnessUpdateRecord {
  id: string;
  harness: string;
  repo: string;
  fromVersion: string;
  fromSha256: string;
  toVersion: string;
  toSha256: string | null;
  asset: string;
  releaseUrl: string;
  releaseBody: string;
  state: HarnessUpdateState;
  evaluation: unknown;
  recommendation: "apply" | "hold" | null;
  prUrl: string | null;
  prBranch: string | null;
  revertPrUrl: string | null;
  revertBranch: string | null;
}

export interface NewHarnessUpdate {
  harness: string;
  repo: string;
  fromVersion: string;
  fromSha256: string;
  toVersion: string;
  asset: string;
  releaseUrl: string;
  releaseBody: string;
}

const COLUMNS = `id,harness,repo,from_version,from_sha256,to_version,to_sha256,asset,release_url,release_body,state,evaluation,recommendation,pr_url,pr_branch,revert_pr_url,revert_branch`;

type Row = Record<string, unknown>;
const record = (row: Row): HarnessUpdateRecord => ({
  id: row.id as string,
  harness: row.harness as string,
  repo: row.repo as string,
  fromVersion: row.from_version as string,
  fromSha256: row.from_sha256 as string,
  toVersion: row.to_version as string,
  toSha256: (row.to_sha256 as string | null) ?? null,
  asset: row.asset as string,
  releaseUrl: row.release_url as string,
  releaseBody: row.release_body as string,
  state: row.state as HarnessUpdateState,
  evaluation: row.evaluation ?? null,
  recommendation: (row.recommendation as "apply" | "hold" | null) ?? null,
  prUrl: (row.pr_url as string | null) ?? null,
  prBranch: (row.pr_branch as string | null) ?? null,
  revertPrUrl: (row.revert_pr_url as string | null) ?? null,
  revertBranch: (row.revert_branch as string | null) ?? null,
});

export class HarnessUpdatesStore {
  constructor(private readonly db: PostgresStore) {}

  private async event(
    updateId: string,
    step: string,
    actor?: string,
    detail?: unknown,
  ): Promise<void> {
    await this.db.pool.query(
      "INSERT INTO harness_update_events(update_id,step,actor,detail) VALUES($1,$2,$3,$4)",
      [updateId, step, actor ?? null, detail === undefined ? null : detail],
    );
  }

  /** Records a release once; a version seen before returns null. */
  async detect(input: NewHarnessUpdate): Promise<HarnessUpdateRecord | null> {
    const result = await this.db.pool.query(
      `INSERT INTO harness_updates(id,harness,repo,from_version,from_sha256,to_version,asset,release_url,release_body,state)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_evaluation')
       ON CONFLICT(harness,to_version) DO NOTHING RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.harness,
        input.repo,
        input.fromVersion,
        input.fromSha256,
        input.toVersion,
        input.asset,
        input.releaseUrl,
        input.releaseBody.slice(0, 20000),
      ],
    );
    if (!result.rowCount) return null;
    const created = record(result.rows[0] as Row);
    await this.event(created.id, "detected", undefined, {
      from: created.fromVersion,
      to: created.toVersion,
    });
    return created;
  }

  async get(id: string): Promise<HarnessUpdateRecord | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const result = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM harness_updates WHERE id=$1`,
      [id],
    );
    return result.rowCount ? record(result.rows[0] as Row) : null;
  }

  async pendingEvaluation(): Promise<HarnessUpdateRecord[]> {
    const result = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM harness_updates WHERE state='pending_evaluation' ORDER BY created_at`,
    );
    return result.rows.map((row) => record(row as Row));
  }

  /** Stores the evaluation; the update stays pending until the owner is notified. */
  async saveEvaluation(
    id: string,
    evaluation: unknown,
    recommendation: "apply" | "hold",
    toSha256: string | null,
  ): Promise<void> {
    await this.db.pool.query(
      "UPDATE harness_updates SET evaluation=$2,recommendation=$3,to_sha256=$4 WHERE id=$1 AND state='pending_evaluation'",
      [id, JSON.stringify(evaluation), recommendation, toSha256],
    );
    await this.event(id, "evaluated", undefined, { recommendation });
  }

  /** Evaluated updates that have not been announced to the owner yet. */
  async awaitingNotice(): Promise<HarnessUpdateRecord[]> {
    const result = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM harness_updates WHERE state='pending_evaluation' AND recommendation IS NOT NULL ORDER BY created_at`,
    );
    return result.rows.map((row) => record(row as Row));
  }

  async markNotified(id: string): Promise<void> {
    const changed = await this.db.pool.query(
      "UPDATE harness_updates SET state='notified',notified_at=now(),remind_at=NULL WHERE id=$1 AND state='pending_evaluation'",
      [id],
    );
    if (changed.rowCount) await this.event(id, "notified");
  }

  /** Notified updates whose "later" reminder is due. */
  async dueReminders(now: Date): Promise<HarnessUpdateRecord[]> {
    const result = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM harness_updates WHERE state='notified' AND remind_at IS NOT NULL AND remind_at<=$1 ORDER BY remind_at`,
      [now],
    );
    return result.rows.map((row) => record(row as Row));
  }

  async clearReminder(id: string): Promise<void> {
    await this.db.pool.query(
      "UPDATE harness_updates SET remind_at=NULL WHERE id=$1",
      [id],
    );
    await this.event(id, "reminded");
  }

  async postpone(id: string, actor: string, until: Date): Promise<boolean> {
    const changed = await this.db.pool.query(
      "UPDATE harness_updates SET remind_at=$2 WHERE id=$1 AND state='notified'",
      [id, until],
    );
    if (changed.rowCount) await this.event(id, "postponed", actor);
    return !!changed.rowCount;
  }

  /** Compare-and-set; false means someone else already moved the update. */
  async transition(
    id: string,
    from: HarnessUpdateState[],
    to: HarnessUpdateState,
    actor?: string,
    step?: string,
    detail?: unknown,
  ): Promise<boolean> {
    const changed = await this.db.pool.query(
      `UPDATE harness_updates SET state=$3,
         decided_by=COALESCE($4,decided_by),
         decided_at=CASE WHEN $4::text IS NULL THEN decided_at ELSE now() END
       WHERE id=$1 AND state=ANY($2::text[])`,
      [id, from, to, actor ?? null],
    );
    if (changed.rowCount) await this.event(id, step ?? to, actor, detail);
    return !!changed.rowCount;
  }

  async recordPr(
    id: string,
    kind: "apply" | "revert",
    url: string,
    branch: string,
  ): Promise<void> {
    const apply = kind === "apply";
    await this.db.pool.query(
      apply
        ? "UPDATE harness_updates SET pr_url=$2,pr_branch=$3,state='pr_open' WHERE id=$1"
        : "UPDATE harness_updates SET revert_pr_url=$2,revert_branch=$3,state='revert_pr_open' WHERE id=$1",
      [id, url, branch],
    );
    await this.event(id, apply ? "pr_opened" : "revert_pr_opened", undefined, {
      url,
      branch,
    });
  }

  async openPullRequests(): Promise<HarnessUpdateRecord[]> {
    const result = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM harness_updates WHERE state IN ('pr_open','revert_pr_open') ORDER BY created_at`,
    );
    return result.rows.map((row) => record(row as Row));
  }

  async logEvent(
    id: string,
    step: string,
    actor?: string,
    detail?: unknown,
  ): Promise<void> {
    await this.event(id, step, actor, detail);
  }
}
