import type { GitHubRequest } from "@rapi/core";
import type { PostgresStore } from "./postgres-store.js";

export interface GitHubDelivery {
  deliveryId: string;
  event: string;
  repo: string;
  request: GitHubRequest;
}

/** Inbox shared by the bot (writes) and the ChatOps process (claims). */
export class GitHubStore {
  constructor(private readonly db: PostgresStore) {}

  /** False when the delivery id was already seen (a replay). */
  async enqueue(delivery: GitHubDelivery): Promise<boolean> {
    const result = await this.db.pool.query(
      `INSERT INTO github_deliveries(delivery_id,event,repo,request) VALUES($1,$2,$3,$4) ON CONFLICT(delivery_id) DO NOTHING`,
      [delivery.deliveryId, delivery.event, delivery.repo, delivery.request],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async claimNext(): Promise<GitHubDelivery | undefined> {
    const result = await this.db.pool.query<{
      delivery_id: string;
      event: string;
      repo: string;
      request: GitHubRequest;
    }>(
      `UPDATE github_deliveries SET state='claimed',claimed_at=now() WHERE delivery_id=(SELECT delivery_id FROM github_deliveries WHERE state='pending' ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING delivery_id,event,repo,request`,
    );
    const row = result.rows[0];
    return row
      ? {
          deliveryId: row.delivery_id,
          event: row.event,
          repo: row.repo,
          request: row.request,
        }
      : undefined;
  }

  async finish(deliveryId: string, state: "done" | "failed"): Promise<void> {
    await this.db.pool.query(
      "UPDATE github_deliveries SET state=$2 WHERE delivery_id=$1",
      [deliveryId, state],
    );
  }

  /** After a restart a claimed delivery may have half-run; never replay it. */
  async failClaimed(): Promise<number> {
    const result = await this.db.pool.query(
      "UPDATE github_deliveries SET state='failed' WHERE state='claimed'",
    );
    return result.rowCount ?? 0;
  }

  async linkRun(
    runId: string,
    sourceId: string,
    repo: string,
    issueNumber: number,
  ): Promise<void> {
    await this.db.pool.query(
      "INSERT INTO github_run_targets(run_id,source_id,repo,issue_number) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [runId, sourceId, repo, issueNumber],
    );
  }

  async setPullRequest(runId: string, url: string): Promise<void> {
    await this.db.pool.query(
      "UPDATE github_run_targets SET pr_url=$2 WHERE run_id=$1",
      [runId, url],
    );
  }

  /** True for the one worker that first claims this week's report. */
  async claimReport(weekKey: string): Promise<boolean> {
    const result = await this.db.pool.query(
      "INSERT INTO github_report_claims(week_key) VALUES($1) ON CONFLICT DO NOTHING",
      [weekKey],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
