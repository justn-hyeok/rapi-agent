import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiSummarizer,
  MeteredModelClient,
  ModelApiError,
  ModelBudgetExceededError,
  OpenAiCompatibleModelClient,
  createModelClient,
  parsePriceTable,
  type ModelBudgetNotifier,
  type ModelClient,
  type ModelUsageEntry,
  type ModelUsageLedger,
} from "@rapi/adapters";
import {
  budgetMonth,
  evaluateBudget,
  formatModelCostReport,
  microUsdFromUsd,
} from "@rapi/core";

const KEY = "sk-secret-key-123";
const completion = (
  content = "hello",
  usage: Record<string, number> = {
    prompt_tokens: 1000,
    completion_tokens: 500,
  },
) => ({ model: "gpt-4o-mini", choices: [{ message: { content } }], usage });

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(responses: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const prices = parsePriceTable(
  JSON.stringify({
    models: {
      "gpt-4o-mini": {
        inputMicroUsdPerMillion: 150000,
        outputMicroUsdPerMillion: 600000,
      },
    },
  }),
);

const sentBody = (call: Call) =>
  JSON.parse(call.init.body as string) as {
    model: string;
    messages: unknown;
    max_tokens?: number;
    response_format?: unknown;
  };

function client(responses: Array<Response | Error>, extra = {}) {
  const fake = fakeFetch(responses);
  const sleeps: number[] = [];
  return {
    ...fake,
    sleeps,
    client: new OpenAiCompatibleModelClient({
      baseUrl: "http://127.0.0.1:4000/v1/",
      apiKey: KEY,
      defaultModel: "gpt-4o-mini",
      prices,
      fetch: fake.fetch,
      sleep: async (ms) => void sleeps.push(ms),
      ...extra,
    }),
  };
}
const request = {
  feature: "summary" as const,
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
};

test("sends a chat completions request and parses usage and table cost", async () => {
  const { client: c, calls } = client([json(completion())]);
  const response = await c.complete({ ...request, maxOutputTokens: 100 });
  assert.equal(calls[0]!.url, "http://127.0.0.1:4000/v1/chat/completions");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  const body = sentBody(calls[0]!);
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(body.max_tokens, 100);
  assert.equal(body.response_format, undefined);
  assert.equal(response.text, "hello");
  // 1000 * 0.15 + 500 * 0.6 = 450 micro-USD
  assert.deepEqual(response.usage, {
    inputTokens: 1000,
    outputTokens: 500,
    costMicroUsd: 450,
    costSource: "table",
  });
});

test("uses response_format json_schema when a schema is given", async () => {
  const { client: c, calls } = client([json(completion("{}"))]);
  await c.complete({ ...request, jsonSchema: { type: "object" } });
  const body = sentBody(calls[0]!);
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: { name: "response", strict: true, schema: { type: "object" } },
  });
});

test("prefers the LiteLLM cost header over the price table", async () => {
  const { client: c } = client([
    json(completion(), { headers: { "x-litellm-response-cost": "0.00123" } }),
  ]);
  const response = await c.complete(request);
  assert.equal(response.usage.costMicroUsd, 1230);
  assert.equal(response.usage.costSource, "gateway");
});

test("unknown model costs 0 and is flagged", async () => {
  const { client: c } = client([json({ ...completion(), model: "mystery" })], {
    defaultModel: "mystery",
  });
  const response = await c.complete(request);
  assert.equal(response.usage.costMicroUsd, 0);
  assert.equal(response.usage.costSource, "unknown");
});

test("per-feature model overrides the default", async () => {
  const { client: c, calls } = client([json(completion())], {
    modelsByFeature: { public_qa: "claude-x" },
  });
  await c.complete({ ...request, feature: "public_qa" });
  assert.equal(sentBody(calls[0]!).model, "claude-x");
});

test("retries 429 and 5xx with backoff, then succeeds", async () => {
  const {
    client: c,
    calls,
    sleeps,
  } = client([
    new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
    new Response("oops", { status: 503 }),
    json(completion()),
  ]);
  const response = await c.complete(request);
  assert.equal(response.text, "hello");
  assert.equal(calls.length, 3);
  assert.equal(sleeps[0], 2000);
  assert.equal(sleeps.length, 2);
});

test("gives up after the bounded retries", async () => {
  const { client: c, calls } = client([
    new Response("x", { status: 500 }),
    new Response("x", { status: 500 }),
    new Response("x", { status: 500 }),
    json(completion()),
  ]);
  await assert.rejects(c.complete(request), (error: ModelApiError) => {
    assert.equal(error.status, 500);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("does not retry other 4xx or timeouts", async () => {
  const a = client([new Response("bad", { status: 400 }), json(completion())]);
  await assert.rejects(a.client.complete(request), /returned 400/);
  assert.equal(a.calls.length, 1);
  const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
  const b = client([timeout, json(completion())]);
  await assert.rejects(b.client.complete(request), /timed out/);
  assert.equal(b.calls.length, 1);
});

test("an aborted caller signal stops without a request", async () => {
  const { client: c, calls } = client([json(completion())]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    c.complete({ ...request, signal: controller.signal }),
    /aborted/,
  );
  assert.equal(calls.length, 0);
});

test("the API key never appears in errors", async () => {
  const echo = client([new Response(`invalid key ${KEY}`, { status: 401 })]);
  await assert.rejects(echo.client.complete(request), (error: Error) => {
    assert.ok(!error.message.includes(KEY));
    assert.ok(!String(error.stack).includes(KEY));
    return true;
  });
  const network = client([
    new Error(`connect failed with Bearer ${KEY}`),
    new Error(`connect failed with Bearer ${KEY}`),
    new Error(`connect failed with Bearer ${KEY}`),
  ]);
  await assert.rejects(network.client.complete(request), (error: Error) => {
    assert.ok(!error.message.includes(KEY));
    return true;
  });
});

test("missing model configuration is a clear error", async () => {
  const { client: c } = client([], { defaultModel: undefined });
  await assert.rejects(c.complete(request), /MODEL_FOR_SUMMARY/);
});

// --- metering and cap ---

class FakeLedger implements ModelUsageLedger {
  rows: ModelUsageEntry[] = [];
  alerts = new Set<string>();
  spent = 0;
  async record(entry: ModelUsageEntry) {
    this.rows.push(entry);
    this.spent += entry.costMicroUsd;
  }
  async spendMicroUsd() {
    return this.spent;
  }
  async claimBudgetAlert(month: string, level: string) {
    const key = `${month}:${level}`;
    if (this.alerts.has(key)) return false;
    this.alerts.add(key);
    return true;
  }
  async releaseBudgetAlert(month: string, level: string) {
    this.alerts.delete(`${month}:${level}`);
  }
}
const costly = (costMicroUsd: number): ModelClient => ({
  async complete() {
    return {
      text: "ok",
      model: "m",
      usage: { inputTokens: 10, outputTokens: 5, costMicroUsd },
    };
  },
});

function metered(inner: ModelClient, budgetUsd?: number) {
  const ledger = new FakeLedger();
  const messages: string[] = [];
  const notifier: ModelBudgetNotifier = {
    async notifySuperadmins(text) {
      messages.push(text);
      return true;
    },
  };
  return {
    ledger,
    messages,
    client: new MeteredModelClient(inner, ledger, {
      budgetMicroUsd: budgetUsd ? microUsdFromUsd(budgetUsd) : undefined,
      notifier,
    }),
  };
}

test("every call is recorded, including failures", async () => {
  const ok = metered(costly(250));
  await ok.client.complete(request);
  assert.deepEqual(
    { ...ok.ledger.rows[0], latencyMs: 0 },
    {
      feature: "summary",
      model: "m",
      inputTokens: 10,
      outputTokens: 5,
      costMicroUsd: 250,
      ok: true,
      latencyMs: 0,
    },
  );
  const failing = metered({
    async complete() {
      throw new ModelApiError("boom", 500);
    },
  });
  await assert.rejects(failing.client.complete(request), /boom/);
  assert.equal(failing.ledger.rows[0]!.ok, false);
  assert.equal(failing.ledger.rows[0]!.error, "boom");
});

test("unknown prices are noted on the row", async () => {
  const inner: ModelClient = {
    async complete() {
      return {
        text: "ok",
        model: "m",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          costMicroUsd: 0,
          costSource: "unknown",
        },
      };
    },
  };
  const m = metered(inner);
  await m.client.complete(request);
  assert.equal(m.ledger.rows[0]!.note, "unknown_price");
});

test("no budget means metering only", async () => {
  const m = metered(costly(1_000_000_000));
  await m.client.complete({ ...request, feature: "public_qa" });
  await m.client.complete({ ...request, feature: "public_qa" });
  assert.equal(m.messages.length, 0);
  assert.equal(m.ledger.rows.length, 2);
});

test("80% alerts once; 100% blocks public features, owner features continue", async () => {
  const m = metered(costly(microUsdFromUsd(8)), 10);
  await m.client.complete({ ...request, feature: "public_qa" }); // 80%
  assert.equal(m.messages.length, 1);
  assert.match(m.messages[0]!, /80%/);
  await m.client.complete({ ...request, feature: "public_qa" }); // 160%
  assert.equal(m.messages.length, 2);
  assert.match(m.messages[1]!, /넘었습니다/);
  // Public feature is now blocked, with no further alert and no new row.
  await assert.rejects(
    m.client.complete({ ...request, feature: "chatbot" }),
    ModelBudgetExceededError,
  );
  assert.equal(m.messages.length, 2);
  assert.equal(m.ledger.rows.length, 2);
  // Owner features keep running.
  for (const feature of ["summary", "blog_draft", "repo_report"] as const)
    await m.client.complete({ ...request, feature });
  assert.equal(m.ledger.rows.length, 5);
  assert.equal(m.messages.length, 2);
});

test("an undelivered alert is retried on the next call", async () => {
  const ledger = new FakeLedger();
  let reachable = false;
  const sent: string[] = [];
  const c = new MeteredModelClient(costly(microUsdFromUsd(9)), ledger, {
    budgetMicroUsd: microUsdFromUsd(10),
    notifier: {
      async notifySuperadmins(text) {
        if (reachable) sent.push(text);
        return reachable;
      },
    },
  });
  await c.complete(request);
  assert.equal(sent.length, 0);
  reachable = true;
  await c.complete({ ...request, feature: "summary" });
  assert.match(sent[0]!, /80%/);
});

test("month boundary is the calendar month in Asia/Seoul", () => {
  // 2026-10-31 15:00Z is 2026-11-01 00:00 in Seoul.
  const before = budgetMonth(new Date("2026-10-31T14:59:59Z"));
  const after = budgetMonth(new Date("2026-10-31T15:00:00Z"));
  assert.equal(before.key, "2026-10");
  assert.equal(after.key, "2026-11");
  assert.equal(before.endsAt.toISOString(), "2026-10-31T15:00:00.000Z");
  assert.equal(after.startsAt.toISOString(), "2026-10-31T15:00:00.000Z");
  assert.equal(after.endsAt.toISOString(), "2026-11-30T15:00:00.000Z");
  assert.equal(budgetMonth(new Date("2026-12-15T00:00:00Z")).key, "2026-12");
  assert.equal(
    budgetMonth(new Date("2026-12-15T00:00:00Z")).endsAt.toISOString(),
    "2026-12-31T15:00:00.000Z",
  );
});

test("evaluateBudget thresholds", () => {
  const budget = 100;
  const at = (spentMicroUsd: number, publicFeature: boolean) =>
    evaluateBudget({ spentMicroUsd, budgetMicroUsd: budget, publicFeature });
  assert.deepEqual(at(79, true), { percent: 79, blocked: false, alert: null });
  assert.equal(at(80, true).alert, "warn");
  assert.equal(at(80, true).blocked, false);
  assert.equal(at(100, true).alert, "exceeded");
  assert.equal(at(100, true).blocked, true);
  assert.equal(at(100, false).blocked, false);
  assert.equal(
    evaluateBudget({
      spentMicroUsd: 1e12,
      budgetMicroUsd: undefined,
      publicFeature: true,
    }).blocked,
    false,
  );
});

test("cost report lists features for this and last month", () => {
  const text = formatModelCostReport({
    thisMonth: [{ feature: "summary", calls: 3, costMicroUsd: 1_500_000 }],
    lastMonth: [],
    budgetMicroUsd: 10_000_000,
  });
  assert.match(text, /이번 달: \$1\.5000 \/ 상한 \$10\.00 \(15%\)/);
  assert.match(text, /요약: \$1\.5000 · 3회/);
  assert.match(text, /지난달: \$0\.0000/);
});

test("factory returns null when unconfigured, a client when configured", () => {
  const ledger = new FakeLedger();
  assert.equal(createModelClient({}, ledger), null);
  assert.equal(createModelClient({ MODEL_API_KEY: "k" }, ledger), null);
  assert.equal(
    createModelClient(
      { MODEL_API_BASE_URL: "http://127.0.0.1:4000/v1" },
      ledger,
    ),
    null,
  );
  const configured = createModelClient(
    {
      MODEL_API_BASE_URL: "http://127.0.0.1:4000/v1",
      MODEL_API_KEY: "k",
      MODEL_DEFAULT: "gpt-4o-mini",
    },
    ledger,
    undefined,
    { onWarning: () => undefined },
  );
  assert.ok(configured);
});

test("api summarizer maps a JSON reply to summaries", async () => {
  const seen: string[] = [];
  const summarizer = new ApiSummarizer({
    async complete(req) {
      seen.push(req.feature);
      return {
        text: JSON.stringify({
          summaries: [{ id: "a", summary: "요약 문장" }],
        }),
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 0 },
      };
    },
  });
  const result = await summarizer.summarize([
    { id: "a", title: "t", body: "b", url: "https://x/a" },
  ]);
  assert.equal(result.get("a"), "요약 문장");
  assert.deepEqual(seen, ["summary"]);
});

test("raising the budget re-arms the alerts for the same month", async () => {
  const ledger = new FakeLedger();
  const messages: string[] = [];
  const notifier: ModelBudgetNotifier = {
    async notifySuperadmins(text) {
      messages.push(text);
      return true;
    },
  };
  const at = (budgetUsd: number) =>
    new MeteredModelClient(costly(microUsdFromUsd(9)), ledger, {
      budgetMicroUsd: microUsdFromUsd(budgetUsd),
      notifier,
      now: () => new Date("2026-10-10T00:00:00Z"),
    });
  const first = at(10);
  const call = (client: MeteredModelClient) =>
    client.complete({ ...request, feature: "summary" });
  await call(first); // $9 spent: 90%, warn
  await call(first); // $18 spent: exceeded
  await call(first);
  await call(first);
  assert.equal(messages.length, 2);
  assert.match(messages[0]!, /80%/);
  assert.match(messages[1]!, /넘었습니다/);
  // The owner raises the cap to $30 (spent is $36, past it): the same month
  // alerts again, once.
  const raised = at(30);
  await call(raised);
  await call(raised);
  assert.equal(messages.length, 3);
  assert.match(messages[2]!, /넘었습니다/);
});
