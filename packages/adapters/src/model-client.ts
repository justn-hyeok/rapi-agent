/**
 * Direct model calls (API key or an OpenAI-compatible gateway such as LiteLLM).
 * Never backed by a subscription-login CLI: these calls may answer other people.
 */

/** Which Rapi feature a call belongs to; used for metering and the monthly cap. */
export type ModelFeature =
  | "summary"
  | "rewrite"
  | "archive_qa"
  | "public_qa"
  | "chatbot"
  | "blog_draft"
  | "repo_report";

/** Public features stop at 100% of the monthly cap; owner features keep running. */
export const PUBLIC_MODEL_FEATURES: ReadonlySet<ModelFeature> = new Set([
  "archive_qa",
  "public_qa",
  "chatbot",
  "rewrite",
]);

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  feature: ModelFeature;
  system: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  /** Optional JSON schema; the reply text is then a JSON document. */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in micro-USD (1e-6 USD). */
  costMicroUsd: number;
}

export interface ModelResponse {
  text: string;
  model: string;
  usage: ModelUsage;
}

export class ModelBudgetExceededError extends Error {
  constructor(readonly feature: ModelFeature) {
    super(`monthly model budget reached; ${feature} is paused`);
    this.name = "ModelBudgetExceededError";
  }
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
