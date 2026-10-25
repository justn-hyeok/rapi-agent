import type { PostgresStore } from "./postgres-store.js";

export interface ModelUsageRow {
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  ok: boolean;
  error?: string | undefined;
  latencyMs: number;
  note?: string | undefined;
}

export interface FeatureCost {
  feature: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

export class ModelUsageStore {
  constructor(private readonly db: PostgresStore) {}

  async record(row: ModelUsageRow, at = new Date()): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO model_usage(at,feature,model,input_tokens,output_tokens,cost_micro_usd,ok,error,latency_ms,note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        at,
        row.feature,
        row.model,
        row.inputTokens,
        row.outputTokens,
        row.costMicroUsd,
        row.ok,
        row.error?.slice(0, 500) ?? null,
        row.latencyMs,
        row.note ?? null,
      ],
    );
  }

  /** Total cost in micro-USD for calls in [from, to). */
  async spendMicroUsd(from: Date, to: Date): Promise<number> {
    const result = await this.db.pool.query<{ total: string }>(
      "SELECT COALESCE(sum(cost_micro_usd),0)::text AS total FROM model_usage WHERE at>=$1 AND at<$2",
      [from, to],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async costByFeature(from: Date, to: Date): Promise<FeatureCost[]> {
    const result = await this.db.pool.query<Record<string, string>>(
      `SELECT feature, count(*)::text AS calls,
              count(*) FILTER (WHERE NOT ok)::text AS failures,
              COALESCE(sum(input_tokens),0)::text AS input_tokens,
              COALESCE(sum(output_tokens),0)::text AS output_tokens,
              COALESCE(sum(cost_micro_usd),0)::text AS cost
       FROM model_usage WHERE at>=$1 AND at<$2
       GROUP BY feature ORDER BY sum(cost_micro_usd) DESC, feature`,
      [from, to],
    );
    return result.rows.map((row) => ({
      feature: row.feature!,
      calls: Number(row.calls),
      failures: Number(row.failures),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      costMicroUsd: Number(row.cost),
    }));
  }

  /** True only for the first caller of a month/level, across processes. */
  async claimBudgetAlert(
    month: string,
    level: "warn" | "exceeded",
  ): Promise<boolean> {
    const result = await this.db.pool.query(
      "INSERT INTO model_budget_alerts(month,level) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [month, level],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Lets the next call retry when the owner DM could not be delivered. */
  async releaseBudgetAlert(
    month: string,
    level: "warn" | "exceeded",
  ): Promise<void> {
    await this.db.pool.query(
      "DELETE FROM model_budget_alerts WHERE month=$1 AND level=$2",
      [month, level],
    );
  }
}
