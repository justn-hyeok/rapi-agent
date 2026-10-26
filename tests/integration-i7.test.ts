import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PublicAgentClient,
  PublicQaMeter,
  createModelClient,
  createPublicQaMeter,
  type ModelUsageLedger,
  type ModelUsageEntry,
} from "@rapi/adapters";
import {
  PublicCommunityService,
  createBlogService,
  createGitHubReport,
} from "@rapi/agent";
import {
  BUDGET_REPLY,
  microUsdFromUsd,
  type DeliveryAdapter,
} from "@rapi/core";
import { ChatbotStore, type BlogPostRecord, type NewBlogPost } from "@rapi/db";
import { loadEnvironment } from "../packages/config/src/index.js";
import { runPublicModel } from "../apps/public-agent/src/api-executor.js";
import { createGatewayModelClient } from "../apps/public-agent/src/gateway-client.js";

const OWNER = "123456789012345678";

class FakeLedger implements ModelUsageLedger {
  entries: ModelUsageEntry[] = [];
  spent = 0;
  async record(entry: ModelUsageEntry) {
    this.entries.push(entry);
    this.spent += entry.costMicroUsd;
  }
  async spendMicroUsd() {
    return this.spent;
  }
  async claimBudgetAlert() {
    return true;
  }
  async releaseBudgetAlert() {}
}

/** A real createModelClient (metered) in front of a canned OpenAI-compatible gateway. */
function meteredClient(ledger: FakeLedger, text: string, costUsd = "0.002") {
  const requests: Array<{ model: string }> = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(init?.body as string));
    return Response.json(
      {
        model: "gpt-test",
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
      { headers: { "x-litellm-response-cost": costUsd } },
    );
  };
  const client = createModelClient(
    {
      MODEL_API_BASE_URL: "http://127.0.0.1:4000/v1",
      MODEL_API_KEY: "k",
      MODEL_DEFAULT: "gpt-test",
      MODEL_MONTHLY_BUDGET_USD: 1,
    },
    ledger,
    undefined,
    { fetch: fakeFetch, onWarning: () => undefined },
  );
  assert.ok(client);
  return { client, requests };
}

// ---- 1. model client into the blog and the repo report ----------------------

const guideJson = JSON.stringify({
  title: "Codex 처음 쓰기",
  description: "설치부터 첫 질문까지",
  sections: [{ heading: "설치", body: "먼저 설치해요." }],
  sources: [],
});

class DraftStore {
  posts: BlogPostRecord[] = [];
  async getBySlug(slug: string) {
    return this.posts.find((post) => post.slug === slug) ?? null;
  }
  async create(input: NewBlogPost) {
    const post = {
      id: "00000000-0000-4000-8000-000000000001",
      status: "draft",
      revision: 1,
      topic: input.topic ?? null,
      sourceIssueId: null,
      prUrl: null,
      prBranch: null,
      removePrUrl: null,
      removePrBranch: null,
      publishedAt: null,
      ...input,
    } as BlogPostRecord;
    this.posts.push(post);
    return post;
  }
}

test("the metered model client reaches blog drafts and is recorded as blog_draft", async () => {
  const ledger = new FakeLedger();
  const { client, requests } = meteredClient(ledger, guideJson);
  const store = new DraftStore();
  const sent: string[] = [];
  const config = {
    BLOG_PUBLISH_ENABLED: false,
    BLOG_DRAFTS_ENABLED: true,
    BLOG_REPO: "a/b",
    BLOG_BASE_BRANCH: "main",
    DISCORD_SUPERADMIN_USER_IDS: [OWNER],
  };
  const delivery: DeliveryAdapter = {
    send: async (_target, payload) => {
      sent.push(payload.text);
      return { providerId: "1" };
    },
  };
  const service = createBlogService(
    config,
    store as never,
    {} as never,
    delivery,
    client,
  );
  assert.ok(service);
  assert.match(
    await service.requestDraft({ userId: OWNER }, "Codex 입문", "555"),
    /DM으로 보냈어요/,
  );
  assert.equal(store.posts.length, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(
    ledger.entries.map((entry) => [
      entry.feature,
      entry.ok,
      entry.costMicroUsd,
    ]),
    [["blog_draft", true, 2000]],
  );
  // Without a client (no MODEL_API_*) the same service answers "unavailable".
  const without = createBlogService(
    config,
    store as never,
    {} as never,
    delivery,
  );
  assert.match(
    await without!.requestDraft({ userId: OWNER }, "다른 주제", "556"),
    /꺼져 있어요/,
  );
  assert.equal(store.posts.length, 1);
});

test("the metered model client reaches the weekly repo report as repo_report", async () => {
  const ledger = new FakeLedger();
  const { client } = meteredClient(ledger, "이번 주는 조용했습니다.");
  const sent: string[] = [];
  const build = (model: typeof client | undefined) =>
    createGitHubReport(
      {
        GITHUB_APP_ENABLED: true,
        GITHUB_APP_ALLOWED_OWNERS: ["owner"],
        GITHUB_REPORT_TARGET: "dm",
        DISCORD_SUPERADMIN_USER_IDS: [OWNER],
      },
      {
        store: { claimReport: async () => true },
        app: {
          listInstallations: async () => [{ id: 7, account: "owner" }],
          installationRepos: async () => ["owner/app"],
          repoWeek: async () => ({
            repo: "owner/app",
            mergedPulls: [
              {
                number: 1,
                title: "Fix login",
                mergedAt: "2026-10-20T00:00:00Z",
              },
            ],
            openIssues: [],
            failingChecks: [],
            stalePulls: [],
          }),
          reportIssue: async () => 1,
          comment: async () => undefined,
        } as never,
        delivery: {
          send: async (_target, payload) => {
            sent.push(payload.text);
            return {} as never;
          },
        },
        model,
      },
    );
  const monday = new Date("2026-10-26T01:00:00Z");
  assert.equal(await build(client)!.runDue(monday), 1);
  assert.match(sent[0]!, /요약: 이번 주는 조용했습니다\./);
  assert.deepEqual(
    ledger.entries.map((entry) => entry.feature),
    ["repo_report"],
  );
  // No client: today's deterministic report.
  assert.equal(await build(undefined)!.runDue(monday), 1);
  assert.doesNotMatch(sent[1]!, /요약:/);
});

// ---- 2. public-agent cost ---------------------------------------------------

class FakeAiStore {
  reserved = 0;
  finished: string[] = [];
  async reserveAiUsage() {
    this.reserved += 1;
    return { accepted: true, duplicate: false } as never;
  }
  async markAiUsageStarted() {}
  async releaseAiUsage() {
    return false;
  }
  async finishAiUsage(_id: string, state: string) {
    this.finished.push(state);
  }
  async recentPublicItems() {
    return [];
  }
}

const question = {
  guildId: "1",
  userId: "2",
  requestId: "r1",
  tier: "user" as const,
  text: "라피가 뭐야?",
};

test("public_qa is blocked before forwarding at 100% and usage from the socket is recorded", async () => {
  const ledger = new FakeLedger();
  const meter = new PublicQaMeter(ledger, {
    budgetMicroUsd: microUsdFromUsd(1),
    prices: {
      "gpt-test": {
        inputMicroUsdPerMillion: 1_000_000,
        outputMicroUsdPerMillion: 2_000_000,
      },
    },
    onWarning: () => undefined,
  });
  const store = new FakeAiStore();
  const prompts: string[] = [];
  const transport = {
    async answer(prompt: string) {
      prompts.push(prompt);
      return {
        started: true,
        ok: true,
        output: "라피는 정보 비서예요.",
        reason: "exit" as const,
        usage: {
          model: "gpt-test",
          inputTokens: 1000,
          outputTokens: 500,
          costMicroUsd: 0,
          costSource: "unknown" as const,
        },
      };
    },
  };
  const service = new PublicCommunityService(
    store as never,
    transport,
    true,
    undefined,
    meter,
  );

  const reply = await service.converse(question);
  assert.equal(reply?.content, "라피는 정보 비서예요.");
  // Priced from the caller's table: 1000*1 + 500*2 = 2000 micro-USD.
  assert.deepEqual(
    ledger.entries.map((e) => [
      e.feature,
      e.model,
      e.inputTokens,
      e.outputTokens,
      e.costMicroUsd,
    ]),
    [["public_qa", "gpt-test", 1000, 500, 2000]],
  );

  // At the cap nothing is forwarded and no daily-limit slot is spent.
  ledger.spent = microUsdFromUsd(1);
  const reserved = store.reserved;
  const blocked = await service.converse({ ...question, requestId: "r2" });
  assert.equal(blocked?.content, BUDGET_REPLY);
  assert.equal(prompts.length, 1);
  assert.equal(store.reserved, reserved);
  assert.equal(ledger.entries.length, 1);
});

test("a gateway cost reported by the executor is recorded as is, and no meter means codex behavior", async () => {
  const ledger = new FakeLedger();
  const meter = new PublicQaMeter(ledger, {
    budgetMicroUsd: microUsdFromUsd(1),
  });
  await meter.record(
    "public_qa",
    {
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
      costMicroUsd: 777,
      costSource: "gateway",
    },
    5,
  );
  assert.equal(ledger.entries[0]!.costMicroUsd, 777);
  assert.equal(ledger.entries[0]!.note, "public_agent");

  // Only the api backend is metered; codex keeps today's behavior.
  assert.equal(
    createPublicQaMeter({ PUBLIC_AGENT_BACKEND: "codex" }, ledger),
    undefined,
  );
  assert.ok(
    createPublicQaMeter(
      { PUBLIC_AGENT_BACKEND: "api" },
      ledger,
      () => undefined,
    ),
  );
  const store = new FakeAiStore();
  const service = new PublicCommunityService(
    store as never,
    {
      answer: async () => ({
        started: true,
        ok: true,
        output: "ok",
        reason: "exit" as const,
      }),
    },
    true,
  );
  assert.equal((await service.converse(question))?.content, "ok");
  assert.equal(ledger.entries.length, 1);
});

test("a failing ledger never blocks a public question or breaks the answer", async () => {
  const broken = {
    spendMicroUsd: async () => {
      throw new Error("db down");
    },
    record: async () => {
      throw new Error("db down");
    },
  };
  const meter = new PublicQaMeter(broken, {
    budgetMicroUsd: microUsdFromUsd(1),
    onWarning: () => undefined,
  });
  assert.equal(await meter.blocked("public_qa"), false);
  await meter.record(
    "public_qa",
    {
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 1,
      costSource: "gateway",
    },
    1,
  );
});

test("the executor reports usage and the socket client hands it to the caller", async () => {
  const fake = {
    async complete() {
      return {
        text: "답",
        model: "gpt-test",
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          costMicroUsd: 42,
          costSource: "gateway" as const,
        },
      };
    },
  };
  const result = await runPublicModel("질문", fake, { feature: "public_qa" });
  assert.deepEqual(result.usage, {
    model: "gpt-test",
    inputTokens: 11,
    outputTokens: 7,
    costMicroUsd: 42,
    costSource: "gateway",
  });

  const directory = await mkdtemp(join(tmpdir(), "rapi-i7-"));
  const socketPath = join(directory, "agent.sock");
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(`${JSON.stringify({ type: "started" })}\n`);
    response.end(`${JSON.stringify({ type: "result", ...result })}\n`);
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    const answered = await new PublicAgentClient(socketPath).answer(
      "질문",
      () => undefined,
      {
        feature: "public_qa",
      },
    );
    assert.equal(answered.ok, true);
    assert.deepEqual(answered.usage, result.usage);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("the isolated gateway client reads LiteLLM's response cost header", async () => {
  const withCost = createGatewayModelClient(
    { PUBLIC_AGENT_API_KEY: "k", PUBLIC_AGENT_API_MODEL: "m" },
    async () =>
      Response.json(
        {
          model: "m",
          choices: [{ message: { content: "x" } }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        },
        { headers: { "x-litellm-response-cost": "0.0005" } },
      ),
  );
  const priced = await withCost!.complete({
    feature: "public_qa",
    system: "s",
    messages: [],
  });
  assert.equal(priced.usage.costMicroUsd, 500);
  assert.equal(priced.usage.costSource, "gateway");
  const bare = createGatewayModelClient(
    { PUBLIC_AGENT_API_KEY: "k", PUBLIC_AGENT_API_MODEL: "m" },
    async () =>
      Response.json({ model: "m", choices: [{ message: { content: "x" } }] }),
  );
  const unpriced = await bare!.complete({
    feature: "public_qa",
    system: "s",
    messages: [],
  });
  assert.equal(unpriced.usage.costSource, "unknown");
});

// ---- 5. chatbot archive index includes published blog posts only ------------

test("the archive index copies published blog posts and drops withdrawn ones", async () => {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const db = {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    },
  };
  await new ChatbotStore(db as never, "https://rapi.example/").syncArchive();
  const insert = queries.find((q) => q.sql.includes("FROM blog_posts"));
  assert.ok(insert);
  assert.match(insert.sql, /status='published'/);
  assert.deepEqual(insert.params, ["https://rapi.example"]);
  const remove = queries.find((q) =>
    /DELETE FROM archive_documents/.test(q.sql),
  );
  assert.ok(remove);
  assert.match(
    remove.sql,
    /NOT IN \(SELECT 'blog:'\|\|slug FROM blog_posts WHERE status='published'\)/,
  );

  // No public base URL or a non-https one: blog posts are not indexed at all.
  for (const base of [undefined, "http://rapi.local"]) {
    queries.length = 0;
    await new ChatbotStore(db as never, base).syncArchive();
    assert.equal(
      queries.some((q) => q.sql.includes("blog_posts")),
      false,
    );
  }
});

// ---- 6. configuration sanity ------------------------------------------------

const envExample = readFileSync(".env.example", "utf8");
const configSource = readFileSync("packages/config/src/index.ts", "utf8");

test(".env.example lists every key once", () => {
  const keys = [...envExample.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map(
    (m) => m[1]!,
  );
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test("the config schema declares every key once", () => {
  const schema =
    /z\s*\.object\(\{([\s\S]*?)\n {2}\}\)/.exec(configSource)?.[1] ?? "";
  const keys = [...schema.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map(
    (m) => m[1]!,
  );
  assert.ok(keys.length > 50);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test("every feature flag is off by default (DELIVERY_ENABLED is the old kill switch)", () => {
  const parsed = loadEnvironment({
    RAPI_ENV: "test",
    DATABASE_URL: "postgresql://rapi:rapi@localhost:5432/rapi",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_APPLICATION_ID: "1234567890",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    DISCORD_ALLOWED_USER_IDS: "100",
  }) as unknown as Record<string, unknown>;
  const flags = Object.keys(parsed).filter((key) => key.endsWith("_ENABLED"));
  for (const expected of [
    "WEB_ENABLED",
    "EMAIL_ENABLED",
    "CHATBOT_ENABLED",
    "CHATBOT_L2_ENABLED",
    "CHATBOT_RERANK_ENABLED",
    "BLOG_PUBLISH_ENABLED",
    "BLOG_DRAFTS_ENABLED",
    "GITHUB_APP_ENABLED",
    "HARNESS_UPDATES_ENABLED",
    "LEARNER_EXPERIMENT_ENABLED",
    "PUBLIC_AGENT_ENABLED",
  ])
    assert.ok(flags.includes(expected), `${expected} is a config key`);
  for (const flag of flags)
    if (flag !== "DELIVERY_ENABLED") assert.equal(parsed[flag], false, flag);
});
