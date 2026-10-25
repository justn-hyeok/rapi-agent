import type {
  ModelClient,
  ModelFeature,
  ModelRequest,
  ModelResponse,
} from "./model-client.js";

export interface ModelPrice {
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
}

export type ModelPriceTable = Readonly<Record<string, ModelPrice>>;

export function parsePriceTable(raw: string): ModelPriceTable {
  const parsed = JSON.parse(raw) as { models?: Record<string, unknown> };
  const table: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(parsed.models ?? {})) {
    const { inputMicroUsdPerMillion: input, outputMicroUsdPerMillion: output } =
      (price ?? {}) as Record<string, unknown>;
    if (
      typeof input === "number" &&
      typeof output === "number" &&
      input >= 0 &&
      output >= 0
    )
      table[model] = {
        inputMicroUsdPerMillion: input,
        outputMicroUsdPerMillion: output,
      };
  }
  return table;
}

export function priceFromTable(
  table: ModelPriceTable,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const price = table[model];
  if (!price) return undefined;
  return Math.round(
    (inputTokens * price.inputMicroUsdPerMillion +
      outputTokens * price.outputMicroUsdPerMillion) /
      1_000_000,
  );
}

export class ModelApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelApiError";
  }
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string | undefined;
  /** Per-feature model overrides (`MODEL_FOR_<FEATURE>`). */
  modelsByFeature?: Partial<Record<ModelFeature, string>>;
  prices?: ModelPriceTable;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 10_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Chat Completions client for LiteLLM or any OpenAI-compatible endpoint. */
export class OpenAiCompatibleModelClient implements ModelClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** Model used for a feature: per-feature override, else the default. */
  modelFor(feature: ModelFeature): string {
    const model =
      this.options.modelsByFeature?.[feature] || this.options.defaultModel;
    if (!model)
      throw new ModelApiError(
        `no model configured for ${feature}; set MODEL_DEFAULT or MODEL_FOR_${feature.toUpperCase()}`,
      );
    return model;
  }

  private redact(text: string): string {
    return text.split(this.options.apiKey).join("[redacted]");
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const model = this.modelFor(request.feature);
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: request.system },
        ...request.messages,
      ],
      ...(request.maxOutputTokens
        ? { max_tokens: request.maxOutputTokens }
        : {}),
      ...(request.jsonSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "response",
                strict: true,
                schema: request.jsonSchema,
              },
            },
          }
        : {}),
    });
    for (let attempt = 0; ; attempt += 1) {
      if (request.signal?.aborted)
        throw new ModelApiError("model request aborted");
      const signals = [AbortSignal.timeout(this.timeoutMs)];
      if (request.signal) signals.push(request.signal);
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body,
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        const name = (error as { name?: string }).name;
        // A timeout or abort may already have cost money; do not retry it.
        if (name === "AbortError" || name === "TimeoutError")
          throw new ModelApiError(
            request.signal?.aborted
              ? "model request aborted"
              : `model request timed out after ${this.timeoutMs}ms`,
          );
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new ModelApiError(
          this.redact(
            `model request failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      if (response.ok) return this.parse(response, model);
      const detail = this.redact((await response.text()).slice(0, 300));
      if (RETRY_STATUSES.has(response.status) && attempt < this.maxRetries) {
        await this.sleep(this.backoff(attempt, response.headers));
        continue;
      }
      throw new ModelApiError(
        `model API returned ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
  }

  private backoff(attempt: number, headers?: Headers): number {
    const retryAfter = Number(headers?.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0)
      return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
    return Math.min(500 * 2 ** attempt + Math.random() * 250, MAX_BACKOFF_MS);
  }

  private async parse(
    response: Response,
    requestedModel: string,
  ): Promise<ModelResponse> {
    let json: {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    try {
      json = (await response.json()) as typeof json;
    } catch {
      throw new ModelApiError("model API returned invalid JSON");
    }
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text)
      throw new ModelApiError("model API returned no text");
    const count = (value: unknown): number =>
      typeof value === "number" && value >= 0 ? Math.round(value) : 0;
    const inputTokens = count(json.usage?.prompt_tokens);
    const outputTokens = count(json.usage?.completion_tokens);
    const model =
      typeof json.model === "string" && json.model
        ? json.model
        : requestedModel;
    const gatewayUsd = Number(response.headers.get("x-litellm-response-cost"));
    const hasGatewayCost =
      response.headers.get("x-litellm-response-cost") !== null &&
      Number.isFinite(gatewayUsd) &&
      gatewayUsd >= 0;
    if (hasGatewayCost)
      return {
        text,
        model,
        usage: {
          inputTokens,
          outputTokens,
          costMicroUsd: Math.round(gatewayUsd * 1_000_000),
          costSource: "gateway",
        },
      };
    // Gateways rename models (dated snapshots), so try the requested id too.
    const table = this.options.prices ?? {};
    const priced =
      priceFromTable(table, requestedModel, inputTokens, outputTokens) ??
      priceFromTable(table, model, inputTokens, outputTokens);
    return {
      text,
      model,
      usage: {
        inputTokens,
        outputTokens,
        costMicroUsd: priced ?? 0,
        costSource: priced === undefined ? "unknown" : "table",
      },
    };
  }
}
