import type { ModelClient, ModelRequest, ModelResponse } from "@rapi/adapters";

/** Same name as ModelBudgetExceededError so the executor maps it to a budget reply. */
class GatewayBudgetError extends Error {
  constructor() {
    super("monthly model budget reached");
    this.name = "ModelBudgetExceededError";
  }
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Minimal OpenAI-compatible client (API key or a LiteLLM gateway) for the
 * isolated public executor. Metering and the monthly cap belong to the gateway;
 * a budget rejection from it (HTTP 402, or 400/429 naming the budget) becomes
 * the budget error. Returns undefined until a key and a model are configured.
 */
export function createGatewayModelClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): ModelClient | undefined {
  const key = env.PUBLIC_AGENT_API_KEY;
  const model = env.PUBLIC_AGENT_API_MODEL;
  if (!key || !model) return undefined;
  const base = (
    env.PUBLIC_AGENT_API_BASE_URL ?? "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: request.system },
            ...request.messages,
          ],
          max_completion_tokens: request.maxOutputTokens,
          user: `rapi-${request.feature}`,
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const text = await response.text();
      if (
        response.status === 402 ||
        ([400, 429].includes(response.status) && /budget/i.test(text))
      )
        throw new GatewayBudgetError();
      if (!response.ok)
        throw new Error(`model gateway returned ${response.status}`);
      const parsed = JSON.parse(text) as ChatCompletion;
      return {
        text: parsed.choices?.[0]?.message?.content ?? "",
        model: parsed.model ?? model,
        usage: {
          inputTokens: parsed.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.usage?.completion_tokens ?? 0,
          costMicroUsd: 0,
        },
      };
    },
  };
}
