import {
  createLocalHealthServer,
  summarizeReadiness,
  type DeliveryAdapter,
  type DeliveryResult,
} from "@rapi/core";
import {
  DiscordDeliveryAdapter,
  FeedSourceAdapter,
  GitHubSourceAdapter,
  OmpHttpAdapter,
  SmtpDeliveryAdapter,
} from "@rapi/adapters";
import {
  CompositeDeliveryAdapter,
  RapiAgent,
  WebhookDeliveryWorker,
} from "@rapi/agent";
import { loadEnvironment } from "@rapi/config";
import { PostgresStore } from "@rapi/db";

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
const omp = config.OMP_ENDPOINT
  ? new OmpHttpAdapter(config.OMP_ENDPOINT)
  : { dispatch: () => Promise.reject(new Error("OMP is not configured")) };
const agent = new RapiAgent(store, delivery, omp);
const feed = new FeedSourceAdapter();
const github = new GitHubSourceAdapter(config.GITHUB_READ_TOKEN);
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

type LoopState = {
  running?: boolean;
  lastStartedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
};
const loops: Record<"collection" | "delivery" | "webhook", LoopState> = {
  collection: {},
  delivery: {},
  webhook: {},
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
    await work();
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
  const destination = config.COMMUNITY_GUILD_ID
    ? await store.webhookConnectionByName(
        config.COMMUNITY_GUILD_ID,
        config.TECHNICAL_RSS_WEBHOOK_NAME,
      )
    : null;
  await agent.collectConfiguredSources(feed, github, async (input) => {
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
  });
}

async function deliver(): Promise<void> {
  await agent.runScheduledDeliveries();
}

function report(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Worker failed"}\n`,
  );
}

await runLoop("collection", collect);
await runLoop("delivery", deliver);
const collectionTimer = setInterval(
  () => void runLoop("collection", collect),
  config.POLL_INTERVAL_SECONDS * 1000,
);
const deliveryTimer = setInterval(
  () => void runLoop("delivery", deliver),
  config.DELIVERY_INTERVAL_SECONDS * 1000,
);
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
    const failedSources = sources.filter(
      (source) =>
        source.state === "active" && Number(source.failure_count ?? 0) > 0,
    );
    const activeSources = sources.filter((source) => source.state === "active");
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
          status: failedSources.length > 0 ? "failed" : "ok",
          checkedAt: now.toISOString(),
          required: true,
          details: {
            configured: activeSources.length,
            failing: failedSources.length,
          },
          ...(failedSources.length > 0
            ? { reason: `${failedSources.length} source(s) failing` }
            : {}),
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
        ...Object.entries(loops).map(([name, state]) => ({
          name,
          status: state.lastError ? ("failed" as const) : ("ok" as const),
          checkedAt: state.lastStartedAt ?? now.toISOString(),
          required: name !== "webhook" || !!webhookWorker,
          ...(state.lastSuccessAt
            ? { lastSuccessAt: state.lastSuccessAt }
            : {}),
          ...(state.lastError ? { reason: state.lastError } : {}),
        })),
      ],
      now,
      Math.max(config.POLL_INTERVAL_SECONDS, config.DELIVERY_INTERVAL_SECONDS) *
        2000,
    );
  },
);

const shutdown = (): void => {
  clearInterval(collectionTimer);
  clearInterval(deliveryTimer);
  clearInterval(webhookTimer);
  healthServer.close();
  void store.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
