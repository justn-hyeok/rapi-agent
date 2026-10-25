import { budgetMonth, evaluateBudget, microUsdFromUsd } from "@rapi/core";
import { PUBLIC_MODEL_FEATURES, type ModelFeature } from "./model-client.js";
import type { ModelUsageLedger } from "./metered-model-client.js";
import { loadPrices } from "./model-factory.js";
import {
  priceFromTable,
  type ModelPriceTable,
} from "./openai-compatible-client.js";
import type { PublicAgentUsage } from "./public-agent.js";

export interface PublicQaMeterOptions {
  /** Monthly cap in micro-USD; undefined = record only. */
  budgetMicroUsd?: number | undefined;
  prices?: ModelPriceTable;
  now?: () => Date;
  onWarning?: (message: string) => void;
}

/**
 * The bot/chat side of the isolated public-agent's model calls. The executor
 * has no database, so this checks the same monthly cap (`evaluateBudget`)
 * before a question is forwarded and writes the usage the executor reports
 * into the same `model_usage` ledger the metered client uses.
 */
export class PublicQaMeter {
  constructor(
    private readonly ledger: Pick<ModelUsageLedger, "spendMicroUsd" | "record">,
    private readonly options: PublicQaMeterOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** True when this month's spend already stopped the feature. Fails open if the ledger is down. */
  async blocked(feature: ModelFeature): Promise<boolean> {
    const budget = this.options.budgetMicroUsd;
    if (!budget) return false;
    const month = budgetMonth(this.now());
    try {
      const spent = await this.ledger.spendMicroUsd(
        month.startsAt,
        month.endsAt,
      );
      return evaluateBudget({
        spentMicroUsd: spent,
        budgetMicroUsd: budget,
        publicFeature: PUBLIC_MODEL_FEATURES.has(feature),
      }).blocked;
    } catch (error) {
      this.options.onWarning?.(
        `public model budget check failed: ${String(error)}`,
      );
      return false;
    }
  }

  async record(
    feature: ModelFeature,
    usage: PublicAgentUsage,
    latencyMs: number,
  ): Promise<void> {
    let cost = usage.costMicroUsd;
    let unknownPrice = false;
    if (usage.costSource !== "gateway") {
      const priced = priceFromTable(
        this.options.prices ?? {},
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
      );
      cost = priced ?? 0;
      unknownPrice = priced === undefined;
      if (unknownPrice)
        this.options.onWarning?.(
          `no price for model ${usage.model}; cost recorded as 0`,
        );
    }
    try {
      await this.ledger.record({
        feature,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicroUsd: cost,
        ok: true,
        latencyMs,
        note: unknownPrice ? "unknown_price" : "public_agent",
      });
    } catch (error) {
      this.options.onWarning?.(
        `public model usage was not recorded: ${String(error)}`,
      );
    }
  }
}

/** Metering exists only for the `api` backend; the codex backend is not measured here. */
export function createPublicQaMeter(
  config: {
    PUBLIC_AGENT_BACKEND?: string | undefined;
    MODEL_MONTHLY_BUDGET_USD?: number | undefined;
    MODEL_PRICES_FILE?: string | undefined;
  },
  ledger: Pick<ModelUsageLedger, "spendMicroUsd" | "record">,
  onWarning: (message: string) => void = (message) => console.warn(message),
): PublicQaMeter | undefined {
  if (config.PUBLIC_AGENT_BACKEND !== "api") return undefined;
  return new PublicQaMeter(ledger, {
    budgetMicroUsd: config.MODEL_MONTHLY_BUDGET_USD
      ? microUsdFromUsd(config.MODEL_MONTHLY_BUDGET_USD)
      : undefined,
    prices: loadPrices(
      config.MODEL_PRICES_FILE ?? "ops/model-prices.json",
      onWarning,
    ),
    onWarning,
  });
}
