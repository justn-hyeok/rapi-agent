import type { DeliveryAdapter, DeliveryResult } from "@rapi/core";
import {
  DiscordDeliveryAdapter,
  FeedSourceAdapter,
  GitHubSourceAdapter,
  OmpHttpAdapter,
  SmtpDeliveryAdapter,
} from "@rapi/adapters";
import { CompositeDeliveryAdapter, RapiAgent } from "@rapi/agent";
import { loadEnvironment } from "@rapi/config";
import { PostgresStore } from "@rapi/db";

class DisabledAdapter implements DeliveryAdapter {
  send(): Promise<DeliveryResult> {
    return Promise.reject(new Error("Delivery transport is not configured"));
  }
}

const config = loadEnvironment();
const store = new PostgresStore(config.DATABASE_URL);
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

async function collect(): Promise<void> {
  await agent.collectConfiguredSources(feed, github);
}

async function deliver(): Promise<void> {
  await agent.runScheduledDeliveries();
}

function report(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Worker failed"}\n`,
  );
}

await collect().catch(report);
await deliver().catch(report);
const collectionTimer = setInterval(
  () => void collect().catch(report),
  config.POLL_INTERVAL_SECONDS * 1000,
);
const deliveryTimer = setInterval(
  () => void deliver().catch(report),
  config.DELIVERY_INTERVAL_SECONDS * 1000,
);

const shutdown = (): void => {
  clearInterval(collectionTimer);
  clearInterval(deliveryTimer);
  void store.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
