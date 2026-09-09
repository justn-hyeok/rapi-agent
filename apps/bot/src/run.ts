import type {
  DeliveryAdapter,
  DeliveryResult,
  OmpAdapter,
  OmpDispatchResult,
} from "@rapi/core";
import {
  DiscordDeliveryAdapter,
  OmpHttpAdapter,
  SmtpDeliveryAdapter,
} from "@rapi/adapters";
import {
  CompositeDeliveryAdapter,
  DiscordCommandService,
  RapiAgent,
} from "@rapi/agent";
import { loadEnvironment } from "@rapi/config";
import { PostgresStore } from "@rapi/db";
import {
  createDiscordInteractionServer,
  registerSlashCommands,
} from "./discord-http.js";

class DisabledDeliveryAdapter implements DeliveryAdapter {
  constructor(private readonly reason: string) {}
  send(): Promise<DeliveryResult> {
    return Promise.reject(new Error(this.reason));
  }
}

class DisabledOmpAdapter implements OmpAdapter {
  dispatch(): Promise<OmpDispatchResult> {
    return Promise.reject(
      new Error(
        "OMP is not configured; set OMP_ENDPOINT to enable development tasks",
      ),
    );
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
    : new DisabledDeliveryAdapter("Email transport is not configured");
const delivery = new CompositeDeliveryAdapter({
  discord_dm: discord,
  discord_channel: discord,
  email,
});
const agent = new RapiAgent(
  store,
  delivery,
  config.OMP_ENDPOINT
    ? new OmpHttpAdapter(config.OMP_ENDPOINT)
    : new DisabledOmpAdapter(),
);
const commands = new DiscordCommandService(agent, {
  userIds: config.DISCORD_ALLOWED_USER_IDS,
  ...(config.DISCORD_SUPERADMIN_USER_IDS
    ? { superadminUserIds: config.DISCORD_SUPERADMIN_USER_IDS }
    : {}),
  ...(config.DISCORD_ADMIN_USER_IDS
    ? { adminUserIds: config.DISCORD_ADMIN_USER_IDS }
    : {}),
  ...(config.DISCORD_USER_IDS ? { userUserIds: config.DISCORD_USER_IDS } : {}),
  ...(config.DISCORD_ADMIN_ROLE_IDS
    ? { adminRoleIds: config.DISCORD_ADMIN_ROLE_IDS }
    : {}),
  ...(config.DISCORD_USER_ROLE_IDS
    ? { userRoleIds: config.DISCORD_USER_ROLE_IDS }
    : {}),
  ...(config.DISCORD_ALLOWED_GUILD_IDS
    ? { guildIds: config.DISCORD_ALLOWED_GUILD_IDS }
    : {}),
  ...(config.DISCORD_ALLOWED_CHANNEL_IDS
    ? { channelIds: config.DISCORD_ALLOWED_CHANNEL_IDS }
    : {}),
});

if (process.env.REGISTER_DISCORD_COMMANDS === "true") {
  await registerSlashCommands(
    config.DISCORD_APPLICATION_ID,
    config.DISCORD_BOT_TOKEN,
    config.DISCORD_ALLOWED_GUILD_IDS?.[0],
  );
}

const server = createDiscordInteractionServer(
  commands,
  config.DISCORD_PUBLIC_KEY,
  {
    ...(config.WEBHOOK_SECRET
      ? { webhook: { agent, secret: config.WEBHOOK_SECRET } }
      : {}),
    ...(config.OMP_CALLBACK_SECRET
      ? { omp: { agent, secret: config.OMP_CALLBACK_SECRET } }
      : {}),
  },
);
server.listen(config.PORT, "127.0.0.1", () => {
  process.stdout.write(`rapi-bot listening on 127.0.0.1:${config.PORT}\n`);
});

const shutdown = (): void => {
  server.close(() => {
    void store.close().finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
