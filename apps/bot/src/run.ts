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
  DiscordLayoutManager,
  CompositeDeliveryAdapter,
  DiscordCommandService,
  PublicCommunityService,
  RapiAgent,
  WebhookManager,
} from "@rapi/agent";
import { PublicAgentClient } from "@rapi/adapters";
import { summarizeReadiness } from "@rapi/core";
import { loadEnvironment } from "@rapi/config";
import {
  compareMigrationNames,
  expectedMigrationNames,
  PostgresStore,
} from "@rapi/db";
import {
  createDiscordInteractionServer,
  registerSlashCommands,
} from "./discord-http.js";
import { readFile } from "node:fs/promises";

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

const store = new PostgresStore(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
const discord = new DiscordDeliveryAdapter(config.DISCORD_BOT_TOKEN);
const publicAgent = new PublicAgentClient(config.PUBLIC_AGENT_SOCKET);
const publicCommunity = new PublicCommunityService(store, publicAgent);
const layout = new DiscordLayoutManager(store, {
  botToken: config.DISCORD_BOT_TOKEN,
  layoutFile: config.DISCORD_LAYOUT_FILE,
});
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
const webhookManager =
  config.WEBHOOK_ENCRYPTION_KEY && config.RAPI_PUBLIC_BASE_URL
    ? new WebhookManager(store, {
        encryptionKey: config.WEBHOOK_ENCRYPTION_KEY,
        publicBaseUrl: config.RAPI_PUBLIC_BASE_URL,
        verifyChannel: async (guildId, channelId) => {
          const response = await fetch(
            `https://discord.com/api/v10/channels/${channelId}`,
            {
              redirect: "manual",
              signal: AbortSignal.timeout(3000),
              headers: { authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
            },
          );
          if (!response.ok) {
            await response.arrayBuffer();
            return false;
          }
          const channel = (await response.json()) as { guild_id?: string };
          return channel.guild_id === guildId;
        },
        publicReady: async () => {
          try {
            const marker = JSON.parse(
              await readFile(config.PUBLIC_TUNNEL_VERIFIED_FILE, "utf8"),
            ) as { origin?: string };
            return marker.origin === config.RAPI_PUBLIC_BASE_URL;
          } catch {
            return false;
          }
        },
      })
    : undefined;
const commands = new DiscordCommandService(
  agent,
  {
    userIds: config.DISCORD_ALLOWED_USER_IDS,
    ...(config.DISCORD_SUPERADMIN_USER_IDS
      ? { superadminUserIds: config.DISCORD_SUPERADMIN_USER_IDS }
      : {}),
    ...(config.DISCORD_ADMIN_USER_IDS
      ? { adminUserIds: config.DISCORD_ADMIN_USER_IDS }
      : {}),
    ...(config.DISCORD_USER_IDS
      ? { userUserIds: config.DISCORD_USER_IDS }
      : {}),
    ...(config.DISCORD_ADMIN_ROLE_IDS
      ? { adminRoleIds: config.DISCORD_ADMIN_ROLE_IDS }
      : {}),
    ...(config.DISCORD_USER_ROLE_IDS
      ? { userRoleIds: config.DISCORD_USER_ROLE_IDS }
      : {}),
    guildMembersAreUsers: config.DISCORD_GUILD_MEMBERS_ARE_USERS,
    ...(config.DISCORD_ALLOWED_GUILD_IDS
      ? { guildIds: config.DISCORD_ALLOWED_GUILD_IDS }
      : {}),
    ...(config.DISCORD_ALLOWED_CHANNEL_IDS
      ? { channelIds: config.DISCORD_ALLOWED_CHANNEL_IDS }
      : {}),
  },
  {
    status: async () => {
      try {
        const monitor = JSON.parse(
          await readFile(config.MONITOR_STATE_FILE, "utf8"),
        ) as {
          updatedAt: string;
          components: Array<{
            name: string;
            status: string;
            checkedAt: string;
            lastSuccessAt?: string;
            reason?: string;
            details?: Record<string, unknown>;
          }>;
        };
        const stale =
          Date.now() - new Date(monitor.updatedAt).getTime() >
          config.MONITOR_INTERVAL_SECONDS * 3000;
        return [
          `라피 상태: ${stale ? "확인 불가" : "감시 중"}`,
          ...monitor.components.map(
            (component) =>
              `${component.name}: ${stale ? "unknown" : component.status} · 확인 ${component.checkedAt}` +
              (component.lastSuccessAt
                ? ` · 최근 성공 ${component.lastSuccessAt}`
                : "") +
              (component.reason ? ` · ${component.reason}` : "") +
              (typeof component.details?.percent === "number" ||
              typeof component.details?.percent === "string"
                ? ` · DB ${component.details.percent}%`
                : ""),
          ),
        ].join("\n");
      } catch {
        // Fall back to a direct database check before the monitor has written state.
      }
      try {
        const health = await store.checkHealth();
        return `라피 상태: 정상\nDB 응답: ${health.latencyMs}ms\nDB 사용량: ${health.databaseBytes} bytes`;
      } catch {
        return "라피 상태: 확인 불가\nDB 연결을 확인하지 못했습니다.";
      }
    },
    ...(webhookManager ? { webhooks: webhookManager } : {}),
    usage: {
      status: async (guildId, userId, tier) => {
        const usage = await store.aiUsageStatus(guildId, userId);
        return [
          tier === "staff"
            ? "내 Spark 사용량: 운영진 무제한"
            : `내 Spark 사용량: ${usage.used}회 · 남음 ${usage.remaining}회`,
          `서버 전체: ${usage.globalUsed}회 · 남음 ${usage.globalRemaining}회`,
          `초기화: ${usage.resetAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (Asia/Seoul)`,
        ].join("\n");
      },
      policy: async (guildId) => {
        const policy = await store.aiUsagePolicy(guildId);
        return [
          `USER: 하루 ${policy.userDailyLimit}회 · 쿨다운 ${policy.userCooldownSeconds}초`,
          `서버: 하루 ${policy.globalDailyLimit}회 · 동시 ${policy.globalConcurrency}개`,
          `초기화: ${policy.timezone} ${String(policy.resetHour).padStart(2, "0")}:${String(policy.resetMinute).padStart(2, "0")}`,
          "Discord Administrator는 애플리케이션 사용량 제한을 적용받지 않습니다.",
        ].join("\n");
      },
      update: async (guildId, actorId, input) => {
        const current = await store.aiUsagePolicy(guildId);
        await store.upsertAiUsagePolicy({
          ...current,
          ...input,
          guildId,
          updatedBy: actorId,
        });
        return "Spark 사용 정책을 변경했습니다.";
      },
    },
    serverConfig: {
      preview: (guildId, actorId) => layout.preview(guildId, actorId),
      apply: (guildId, actorId, planId) =>
        layout.apply(guildId, actorId, planId),
      export: (_guildId, format) => layout.export(format),
    },
    publicBrief: async (guildId, userId, requestId, tier) =>
      (await publicCommunity.answer({
        guildId,
        userId,
        requestId,
        tier,
        text: "최근 24시간의 주요 기술 소식을 브리핑해줘.",
        mode: "brief",
      })) ?? "이미 처리한 요청입니다.",
  },
);

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
    ...(webhookManager ? { managedWebhook: webhookManager } : {}),
    component: async (identity, customId) => {
      if (!identity.guildId)
        throw new Error("서버에서만 사용할 수 있는 버튼입니다.");
      if (customId === "rapi_verify:v1")
        return layout.verifyMember(identity.guildId, identity.userId);
      if (customId.startsWith("server_config_apply:")) {
        const result = await commands.execute(identity, {
          name: "server_config",
          options: {
            action: "적용",
            planId: customId.slice("server_config_apply:".length),
          },
        });
        return result.messages[0] ?? "서버 구성을 적용했습니다.";
      }
      throw new Error("알 수 없는 버튼입니다.");
    },
    readiness: async () => {
      try {
        const [
          result,
          publicReady,
          expectedMigrations,
          appliedMigrations,
          staleCount,
        ] = await Promise.all([
          store.checkHealth(),
          publicAgent.readiness(),
          expectedMigrationNames(),
          store.appliedMigrationNames(),
          store.staleExecutionAttemptCount(30 * 60_000),
        ]);
        const migrations = compareMigrationNames(
          expectedMigrations,
          appliedMigrations,
        );
        return summarizeReadiness([
          {
            name: "database",
            status: "ok",
            checkedAt: new Date().toISOString(),
            required: true,
            latencyMs: result.latencyMs,
            details: {
              databaseBytes: result.databaseBytes,
              clusterDatabaseBytes: result.clusterDatabaseBytes,
              differenceBytes:
                result.clusterDatabaseBytes - result.databaseBytes,
            },
          },
          {
            name: "public-agent",
            status: publicReady ? "ok" : "failed",
            checkedAt: new Date().toISOString(),
            required: config.PUBLIC_AGENT_ENABLED,
            ...(publicReady ? {} : { reason: "public executor unavailable" }),
          },
          {
            name: "migrations",
            status: migrations.ok ? "ok" : "failed",
            checkedAt: new Date().toISOString(),
            required: true,
            details: {
              expected: expectedMigrations.length,
              applied: appliedMigrations.length,
              missing: migrations.missing,
              unexpected: migrations.unexpected,
            },
            ...(migrations.ok
              ? {}
              : {
                  reason: "database migration set does not match this revision",
                }),
          },
          {
            name: "executions",
            status: staleCount > 0 ? "unknown" : "ok",
            checkedAt: new Date().toISOString(),
            required: false,
            ...(staleCount > 0
              ? {
                  reason: `${staleCount} execution attempt(s) are stale`,
                  details: { staleCount },
                }
              : {}),
          },
        ]);
      } catch {
        return summarizeReadiness([
          {
            name: "database",
            status: "failed",
            checkedAt: new Date().toISOString(),
            required: true,
            reason: "database unavailable",
          },
        ]);
      }
    },
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
