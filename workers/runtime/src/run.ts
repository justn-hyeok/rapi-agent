import {
  briefingLinkKey,
  createLocalHealthServer,
  summarizeReadiness,
  type DeliveryAdapter,
  type DeliveryResult,
} from "@rapi/core";
import {
  DiscordDeliveryAdapter,
  FeedSourceAdapter,
  GitHubSourceAdapter,
  GitHubStarRecommender,
  ApiSummarizer,
  CodexSummarizer,
  GitHubAppClient,
  GitHubRepositoryInfo,
  SmtpDeliveryAdapter,
  createModelClient,
  superadminDmNotifier,
} from "@rapi/adapters";
import {
  createBlogService,
  createCommunityFeeds,
  createGitHubReport,
  createHarnessUpdates,
  createLearnerExperiment,
  CompositeDeliveryAdapter,
  DEFAULT_SUMMARY_MODEL,
  RapiAgent,
  CrawlerCollector,
  WebhookDeliveryWorker,
} from "@rapi/agent";
import { CrawlerClient } from "@rapi/crawler-client";
import { loadEnvironment } from "@rapi/config";
import {
  BlogPostsStore,
  GitHubStore,
  HarnessUpdatesStore,
  ModelUsageStore,
  PostgresStore,
} from "@rapi/db";
import { readFile } from "node:fs/promises";
import { requireHealthyDeliveryResults } from "./delivery-loop.js";
import { deliveryReadiness } from "./delivery-readiness.js";
import { shouldRunDelivery } from "./delivery-schedule.js";
import { assessSourceHealth } from "./source-health.js";

class DisabledAdapter implements DeliveryAdapter {
  send(): Promise<DeliveryResult> {
    return Promise.reject(new Error("Delivery transport is not configured"));
  }
}

const config = loadEnvironment();
const store = new PostgresStore(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
const discord = new DiscordDeliveryAdapter(config.DISCORD_BOT_TOKEN);
const email: DeliveryAdapter =
  config.EMAIL_TRANSPORT === "smtp" &&
  config.SMTP_HOST &&
  config.SMTP_PORT &&
  config.SMTP_USERNAME &&
  config.SMTP_PASSWORD &&
  config.EMAIL_FROM
    ? new SmtpDeliveryAdapter({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        username: config.SMTP_USERNAME,
        password: config.SMTP_PASSWORD,
        from: config.EMAIL_FROM,
      })
    : new DisabledAdapter();
const delivery = new CompositeDeliveryAdapter({
  discord_dm: discord,
  discord_channel: discord,
  email,
});
// Null unless MODEL_API_BASE_URL and MODEL_API_KEY are set; callers fall back to the CLI.
const modelClient = createModelClient(
  config,
  new ModelUsageStore(store),
  superadminDmNotifier(discord, config.DISCORD_SUPERADMIN_USER_IDS ?? []),
);
const summarizer =
  process.env.SUMMARY_MODEL === "off"
    ? undefined
    : config.SUMMARIZER_BACKEND === "api" && modelClient
      ? new ApiSummarizer(
          modelClient,
          `api:${config.MODEL_FOR_SUMMARY ?? config.MODEL_DEFAULT}`,
        )
      : new CodexSummarizer(process.env.SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL);
const agent = new RapiAgent(
  store,
  delivery,
  summarizer,
  new GitHubRepositoryInfo(config.GITHUB_READ_TOKEN),
  config.WEBHOOK_ENCRYPTION_KEY && config.RAPI_PUBLIC_BASE_URL
    ? {
        key: briefingLinkKey(config.WEBHOOK_ENCRYPTION_KEY),
        baseUrl: config.RAPI_PUBLIC_BASE_URL,
      }
    : undefined,
);
const crawler =
  process.env.CRAWLER_ENDPOINT && process.env.CRAWLER_CALLER_TOKEN
    ? new CrawlerCollector(
        agent,
        new CrawlerClient(
          process.env.CRAWLER_ENDPOINT,
          process.env.CRAWLER_CALLER_TOKEN,
        ),
      )
    : undefined;
// The owner's curation channels: projects, setup and stars, AI blogs, free tokens.
const communityFeeds = config.COMMUNITY_GUILD_ID
  ? await createCommunityFeeds({
      store,
      summarizer,
      guildId: config.COMMUNITY_GUILD_ID,
      extraGuildIds: config.DISCORD_ALLOWED_GUILD_IDS ?? [],
      botToken: config.DISCORD_BOT_TOKEN,
      root: process.cwd(),
      ...(config.GITHUB_READ_TOKEN
        ? { githubToken: config.GITHUB_READ_TOKEN }
        : {}),
    })
  : undefined;
const feed = new FeedSourceAdapter();
const github = new GitHubSourceAdapter(config.GITHUB_READ_TOKEN);
const stars = new GitHubStarRecommender(config.GITHUB_READ_TOKEN);
const webhookWorker = config.WEBHOOK_ENCRYPTION_KEY
  ? new WebhookDeliveryWorker(
      store,
      config.WEBHOOK_ENCRYPTION_KEY,
      async (channelId, content) => {
        await discord.send(
          { channel: "discord_channel", recipientId: channelId },
          { subject: "Rapi webhook", text: content, html: "", itemIds: [] },
        );
      },
    )
  : undefined;

// The shared metered client (above) also feeds blog drafts and the weekly repo
// report; both degrade when it is null.
const githubReport =
  config.GITHUB_APP_ENABLED &&
  config.GITHUB_APP_ID &&
  config.GITHUB_APP_PRIVATE_KEY_PATH
    ? createGitHubReport(config, {
        store: new GitHubStore(store),
        app: new GitHubAppClient({
          appId: config.GITHUB_APP_ID,
          privateKey: await readFile(
            config.GITHUB_APP_PRIVATE_KEY_PATH,
            "utf8",
          ),
        }),
        delivery,
        model: modelClient ?? undefined,
      })
    : undefined;
const blog = createBlogService(
  config,
  new BlogPostsStore(store),
  store,
  discord,
  modelClient ?? undefined,
);
const learner = createLearnerExperiment(
  config,
  store,
  discord,
  blog ? { onIssueSent: (issue) => blog.onIssueSent(issue) } : {},
);
const harnessUpdates = createHarnessUpdates(
  config,
  new HarnessUpdatesStore(store),
  discord,
);

type LoopState = {
  running?: boolean;
  lastStartedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  deliveryOutcome?: "delivered" | "idle";
};
const loops: Record<
  | "collection"
  | "delivery"
  | "webhook"
  | "curation"
  | "learner"
  | "harness"
  | "github"
  | "blog",
  LoopState
> = {
  collection: {},
  delivery: {},
  webhook: {},
  curation: {},
  learner: {},
  harness: {},
  github: {},
  blog: {},
};

async function runLoop(
  name: keyof typeof loops,
  work: () => Promise<unknown>,
): Promise<void> {
  const state = loops[name];
  if (state.running) return;
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  try {
    const result = await work();
    if (name === "delivery")
      state.deliveryOutcome = result === "idle" ? "idle" : "delivered";
    state.lastSuccessAt = new Date().toISOString();
    delete state.lastError;
  } catch (error) {
    state.lastError =
      error instanceof Error ? error.message.slice(0, 200) : "failed";
    report(error);
  } finally {
    state.running = false;
  }
}

async function collect(): Promise<void> {
  if (
    !crawler &&
    (
      await store.pool.query(
        "SELECT 1 FROM sources WHERE state='active' AND collection_policy->'crawler'->>'enabled'='true' LIMIT 1",
      )
    ).rowCount
  )
    throw new Error(
      "Delegated sources require CRAWLER_ENDPOINT and CRAWLER_CALLER_TOKEN",
    );
  await crawler?.runOnce();
  const collected = await agent.collectEvents();
  if (collected.failures.length)
    process.stderr.write(
      `Event sources failed: ${collected.failures.join("; ")}\n`,
    );
  const destination = config.COMMUNITY_GUILD_ID
    ? await store.webhookConnectionByName(
        config.COMMUNITY_GUILD_ID,
        config.TECHNICAL_RSS_WEBHOOK_NAME,
      )
    : null;
  await agent.collectConfiguredSources(
    feed,
    github,
    async (input) => {
      if (
        input.sourceKind !== "rss" ||
        !destination ||
        destination.kind !== "discord_outbound" ||
        destination.state !== "active"
      )
        return;
      await store.enqueueWebhookJob(`rss:${input.itemId}:${destination.id}`, {
        destinationKind: "discord_webhook",
        destinationId: destination.id,
        title: input.item.title,
        summary: input.item.body.slice(0, 1200),
        url: input.item.url,
        sentChunks: 0,
      });
    },
    stars,
  );
}

async function deliver(): Promise<"delivered" | "idle"> {
  const assessment = requireHealthyDeliveryResults(
    await agent.runScheduledDeliveries(),
  );
  return assessment.status === "idle" ? "idle" : "delivered";
}

function report(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Worker failed"}\n`,
  );
}

// Curation calls the model and can take minutes; it never delays startup
// readiness or the collection loop.
async function curate(): Promise<void> {
  const failures = await communityFeeds?.runOnce();
  if (failures?.length)
    throw new Error(`Curation feeds failed: ${failures.join("; ")}`);
}
const curationTimer = communityFeeds
  ? setInterval(() => void runLoop("curation", curate), 5 * 60_000)
  : undefined;

const learnerTimer = learner
  ? setInterval(
      () => void runLoop("learner", () => learner.runDue(new Date())),
      60_000,
    )
  : undefined;

const blogTimer = blog
  ? setInterval(
      () => void runLoop("blog", () => blog.runDue(new Date())),
      5 * 60_000,
    )
  : undefined;

// Detection is rate limited inside the service to every 6 hours.
const harnessTimer = harnessUpdates
  ? setInterval(
      () => void runLoop("harness", () => harnessUpdates.runDue(new Date())),
      10 * 60_000,
    )
  : undefined;
// The report is claimed per week, so a frequent check is cheap and restart-safe.
const githubTimer = githubReport
  ? setInterval(
      () => void runLoop("github", () => githubReport.runDue(new Date())),
      10 * 60_000,
    )
  : undefined;
if (githubReport) void runLoop("github", () => githubReport.runDue(new Date()));
if (harnessUpdates)
  void runLoop("harness", () => harnessUpdates.runDue(new Date()));

await runLoop("collection", collect);
if (shouldRunDelivery(config.DELIVERY_ENABLED))
  await runLoop("delivery", deliver);
const collectionTimer = setInterval(
  () => void runLoop("collection", collect),
  config.POLL_INTERVAL_SECONDS * 1000,
);
const deliveryTimer = shouldRunDelivery(config.DELIVERY_ENABLED)
  ? setInterval(
      () => void runLoop("delivery", deliver),
      config.DELIVERY_INTERVAL_SECONDS * 1000,
    )
  : undefined;
const webhookTimer = setInterval(
  () =>
    void runLoop(
      "webhook",
      () => webhookWorker?.runOnce() ?? Promise.resolve(),
    ),
  1000,
);
const healthServer = createLocalHealthServer(
  config.WORKER_HEALTH_PORT,
  async () => {
    const db = await store.checkHealth();
    const sources = await store.sourceStatus();
    const sourceHealth = assessSourceHealth(
      sources.map((source) => ({
        kind: String(source.kind),
        active: source.state === "active",
        failureCount: Number(source.failure_count ?? 0),
        crawler:
          !!crawler &&
          (source.collection_policy as { crawler?: { enabled?: boolean } })
            .crawler?.enabled === true,
        lastSuccessAt: source.last_success_at as Date | null,
      })),
    );
    const webhookQueue = await store.webhookQueueStatus();
    const now = new Date();
    return summarizeReadiness(
      [
        {
          name: "database",
          status: "ok",
          checkedAt: now.toISOString(),
          required: true,
          latencyMs: db.latencyMs,
          details: {
            databaseBytes: db.databaseBytes,
            clusterDatabaseBytes: db.clusterDatabaseBytes,
          },
        },
        {
          name: "sources",
          status: sourceHealth.status,
          checkedAt: now.toISOString(),
          required: true,
          details: {
            configured: sourceHealth.configured,
            failing: sourceHealth.failing,
            unsupported: sourceHealth.unsupported,
          },
          ...(sourceHealth.reason ? { reason: sourceHealth.reason } : {}),
        },
        {
          name: "webhook_queue",
          status: webhookQueue.deadLetter > 0 ? "failed" : "ok",
          checkedAt: now.toISOString(),
          required: !!webhookWorker,
          details: webhookQueue,
          ...(webhookQueue.deadLetter > 0
            ? { reason: `${webhookQueue.deadLetter} dead-letter job(s)` }
            : {}),
        },
        ...Object.entries(loops).map(([name, state]) => {
          const readiness =
            name === "delivery"
              ? deliveryReadiness(
                  config.DELIVERY_ENABLED,
                  state.lastError,
                  state.deliveryOutcome,
                )
              : undefined;
          const disabled = readiness?.status === "disabled";
          return {
            name,
            status: readiness?.status ?? (state.lastError ? "failed" : "ok"),
            checkedAt: state.lastStartedAt ?? now.toISOString(),
            required:
              !disabled &&
              name !== "curation" &&
              name !== "learner" &&
              name !== "harness" &&
              name !== "github" &&
              name !== "blog" &&
              (name !== "webhook" || !!webhookWorker),
            ...(readiness ? { details: { outcome: readiness.outcome } } : {}),
            ...(state.lastSuccessAt
              ? { lastSuccessAt: state.lastSuccessAt }
              : {}),
            ...(readiness?.reason
              ? { reason: readiness.reason }
              : state.lastError
                ? { reason: state.lastError }
                : {}),
          };
        }),
      ],
      now,
      Math.max(config.POLL_INTERVAL_SECONDS, config.DELIVERY_INTERVAL_SECONDS) *
        2000,
    );
  },
);

const shutdown = (): void => {
  clearInterval(collectionTimer);
  if (curationTimer) clearInterval(curationTimer);
  if (learnerTimer) clearInterval(learnerTimer);
  if (harnessTimer) clearInterval(harnessTimer);
  if (githubTimer) clearInterval(githubTimer);
  if (blogTimer) clearInterval(blogTimer);
  if (deliveryTimer) clearInterval(deliveryTimer);
  clearInterval(webhookTimer);
  healthServer.close();
  void store.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
