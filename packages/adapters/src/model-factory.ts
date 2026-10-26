import { readFileSync } from "node:fs";
import { microUsdFromUsd } from "@rapi/core";
import type { ModelClient, ModelFeature } from "./model-client.js";
import {
  MeteredModelClient,
  type ModelBudgetNotifier,
  type ModelUsageLedger,
} from "./metered-model-client.js";
import {
  OpenAiCompatibleModelClient,
  parsePriceTable,
  type ModelPriceTable,
} from "./openai-compatible-client.js";

export interface ModelClientConfig {
  MODEL_API_BASE_URL?: string | undefined;
  MODEL_API_KEY?: string | undefined;
  MODEL_DEFAULT?: string | undefined;
  MODEL_MONTHLY_BUDGET_USD?: number | undefined;
  MODEL_PRICES_FILE?: string | undefined;
  MODEL_FOR_SUMMARY?: string | undefined;
  MODEL_FOR_REWRITE?: string | undefined;
  MODEL_FOR_ARCHIVE_QA?: string | undefined;
  MODEL_FOR_PUBLIC_QA?: string | undefined;
  MODEL_FOR_CHATBOT?: string | undefined;
  MODEL_FOR_BLOG_DRAFT?: string | undefined;
  MODEL_FOR_REPO_REPORT?: string | undefined;
  MODEL_FOR_GRAPH_EXTRACT?: string | undefined;
}

const FEATURES: ModelFeature[] = [
  "summary",
  "rewrite",
  "archive_qa",
  "public_qa",
  "chatbot",
  "blog_draft",
  "repo_report",
  "graph_extract",
];

export function loadPrices(
  file: string,
  warn: (message: string) => void,
): ModelPriceTable {
  try {
    return parsePriceTable(readFileSync(file, "utf8"));
  } catch (error) {
    warn(`model price table ${file} was not loaded: ${String(error)}`);
    return {};
  }
}

/**
 * Returns the metered client, or null when no gateway/key is configured so
 * callers can keep their existing (CLI-backed) behavior.
 */
export function createModelClient(
  config: ModelClientConfig,
  ledger: ModelUsageLedger,
  notifier?: ModelBudgetNotifier,
  options: {
    fetch?: typeof fetch;
    onWarning?: (message: string) => void;
    pricesFile?: string;
  } = {},
): ModelClient | null {
  if (!config.MODEL_API_BASE_URL || !config.MODEL_API_KEY) return null;
  const warn =
    options.onWarning ?? ((message: string) => console.warn(message));
  const modelsByFeature: Partial<Record<ModelFeature, string>> = {};
  for (const feature of FEATURES) {
    const key = `MODEL_FOR_${feature.toUpperCase()}` as keyof ModelClientConfig;
    const value = config[key];
    if (typeof value === "string" && value) modelsByFeature[feature] = value;
  }
  const inner = new OpenAiCompatibleModelClient({
    baseUrl: config.MODEL_API_BASE_URL,
    apiKey: config.MODEL_API_KEY,
    defaultModel: config.MODEL_DEFAULT,
    modelsByFeature,
    prices: loadPrices(
      options.pricesFile ?? config.MODEL_PRICES_FILE ?? "ops/model-prices.json",
      warn,
    ),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new MeteredModelClient(inner, ledger, {
    budgetMicroUsd: config.MODEL_MONTHLY_BUDGET_USD
      ? microUsdFromUsd(config.MODEL_MONTHLY_BUDGET_USD)
      : undefined,
    notifier,
    onWarning: warn,
    modelFor: (feature) => {
      try {
        return inner.modelFor(feature);
      } catch {
        return "unknown";
      }
    },
  });
}
