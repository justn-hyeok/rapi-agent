import { zonedDateToUtc, zonedParts } from "./usage.js";

export interface BudgetMonth {
  /** `YYYY-MM` in the budget timezone; identifies the month for alert dedup. */
  key: string;
  startsAt: Date;
  endsAt: Date;
}

/** Calendar month containing `now` in `timezone` (Asia/Seoul by default). */
export function budgetMonth(now: Date, timezone = "Asia/Seoul"): BudgetMonth {
  const local = zonedParts(now, timezone);
  const year = local.year!;
  const month = local.month!;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    startsAt: zonedDateToUtc(year, month, 1, 0, 0, timezone),
    endsAt: zonedDateToUtc(nextYear, nextMonth, 1, 0, 0, timezone),
  };
}

export type BudgetAlertLevel = "warn" | "exceeded";

export interface BudgetDecision {
  /** Spend as a percentage of the cap; 0 when no cap is configured. */
  percent: number;
  /** True when this feature must not run: public feature at or over the cap. */
  blocked: boolean;
  /** Highest threshold reached (80% / 100%), regardless of who asked. */
  alert: BudgetAlertLevel | null;
}

export const BUDGET_WARN_PERCENT = 80;

/**
 * Pure cap check. `budgetMicroUsd` undefined or 0 means no cap (metering only).
 * Owner features are never blocked; public features stop at 100%.
 */
export function evaluateBudget(input: {
  spentMicroUsd: number;
  budgetMicroUsd: number | undefined;
  publicFeature: boolean;
}): BudgetDecision {
  const budget = input.budgetMicroUsd;
  if (!budget || budget <= 0)
    return { percent: 0, blocked: false, alert: null };
  const percent = (input.spentMicroUsd / budget) * 100;
  const exceeded = input.spentMicroUsd >= budget;
  return {
    percent,
    blocked: exceeded && input.publicFeature,
    alert: exceeded
      ? "exceeded"
      : percent >= BUDGET_WARN_PERCENT
        ? "warn"
        : null,
  };
}

export const microUsdFromUsd = (usd: number): number =>
  Math.round(usd * 1_000_000);

export const formatUsd = (microUsd: number): string =>
  `$${(microUsd / 1_000_000).toFixed(microUsd >= 10_000_000 ? 2 : 4)}`;

export interface FeatureCostLine {
  feature: string;
  calls: number;
  costMicroUsd: number;
}

const FEATURE_LABELS: Record<string, string> = {
  summary: "요약",
  rewrite: "재작성",
  archive_qa: "아카이브 Q&A",
  public_qa: "공개 Q&A",
  chatbot: "챗봇",
  blog_draft: "블로그 초안",
  repo_report: "저장소 리포트",
  graph_extract: "지식 그래프 추출",
};

/** Korean report lines: model cost per feature, this month and last month. */
export function formatModelCostReport(input: {
  thisMonth: FeatureCostLine[];
  lastMonth: FeatureCostLine[];
  budgetMicroUsd?: number | undefined;
}): string {
  const total = (lines: FeatureCostLine[]): number =>
    lines.reduce((sum, line) => sum + line.costMicroUsd, 0);
  const rows = (lines: FeatureCostLine[]): string[] =>
    lines.map(
      (line) =>
        `  ${FEATURE_LABELS[line.feature] ?? line.feature}: ${formatUsd(line.costMicroUsd)} · ${line.calls}회`,
    );
  const spent = total(input.thisMonth);
  const cap = input.budgetMicroUsd
    ? ` / 상한 ${formatUsd(input.budgetMicroUsd)} (${Math.round((spent / input.budgetMicroUsd) * 100)}%)`
    : " (상한 없음)";
  return [
    `모델 비용 이번 달: ${formatUsd(spent)}${cap}`,
    ...rows(input.thisMonth),
    `모델 비용 지난달: ${formatUsd(total(input.lastMonth))}`,
    ...rows(input.lastMonth),
  ].join("\n");
}
