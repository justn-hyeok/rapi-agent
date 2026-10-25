import type { DeliveryAdapter, DeliveryResult } from "@rapi/core";
import {
  DiscordDeliveryAdapter,
  ApiSummarizer,
  EmailDeliveryAdapter,
  createEmailTransport,
  CodexSummarizer,
  SmtpDeliveryAdapter,
  createModelClient,
  createPublicQaMeter,
  superadminDmNotifier,
} from "@rapi/adapters";
import {
  DiscordLayoutManager,
  GitHubWebhookReceiver,
  CompositeDeliveryAdapter,
  DiscordCommandService,
  PublicCommunityService,
  RapiAgent,
  createCommunityFeeds,
  BlogService,
  createBlogService,
  createHarnessUpdates,
  createEmailService,
  createLearnerExperiment,
  LearnerExperiment,
  decideGuildButton,
  isGuildDecision,
  createWebPortal,
  BillingService,
  loadBillingPlans,
  HarnessUpdateService,
  CHATBOT_SUBSCRIPTION_PREFIX,
  handleChatbotSubscriptionComponent,
  DEFAULT_SUMMARY_MODEL,
  WebhookManager,
} from "@rapi/agent";
import { PublicAgentClient, createTossClient } from "@rapi/adapters";
import {
  assertDiscordAccess,
  briefingLinkKey,
  budgetMonth,
  createGuildGate,
  formatModelCostReport,
  microUsdFromUsd,
  GUILD_NOT_ALLOWED_MESSAGE,
  isGuildAllowed,
  resolveHomeGuildId,
  summarizeReadiness,
} from "@rapi/core";
import { loadEnvironment } from "@rapi/config";
import {
  compareMigrationNames,
  EmailStore,
  expectedMigrationNames,
  GitHubStore,
  BlogPostsStore,
  BillingStore,
  HarnessUpdatesStore,
  ModelUsageStore,
  WebStore,
  PostgresStore,
} from "@rapi/db";
import {
  createDiscordInteractionServer,
  registerSlashCommands,
} from "./discord-http.js";
import { readFile } from "node:fs/promises";
import { executePrivacyCommand } from "../../../scripts/privacy-command.mjs";

class DisabledDeliveryAdapter implements DeliveryAdapter {
  constructor(private readonly reason: string) {}
  send(): Promise<DeliveryResult> {
    return Promise.reject(new Error(this.reason));
  }
}

const config = loadEnvironment();

function webEnabled(
  value: typeof config,
): value is typeof config & { RAPI_PUBLIC_BASE_URL: string } {
  return (
    value.WEB_ENABLED &&
    !!value.DISCORD_OAUTH_CLIENT_ID &&
    !!value.DISCORD_OAUTH_CLIENT_SECRET &&
    !!value.RAPI_PUBLIC_BASE_URL &&
    !!value.WEBHOOK_ENCRYPTION_KEY
  );
}

const store = new PostgresStore(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
const discord = new DiscordDeliveryAdapter(config.DISCORD_BOT_TOKEN);
const publicAgent = new PublicAgentClient(config.PUBLIC_AGENT_SOCKET);
const publicCommunity = new PublicCommunityService(
  store,
  publicAgent,
  config.PUBLIC_AGENT_ENABLED,
  undefined,
  // PUBLIC_AGENT_BACKEND=api: the isolated executor has no database, so the
  // cap is checked here and its reported usage lands in the same ledger.
  createPublicQaMeter(config, new ModelUsageStore(store)),
);
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
const modelUsage = new ModelUsageStore(store);
// Null unless MODEL_API_BASE_URL and MODEL_API_KEY are set; callers fall back to the CLI.
const modelClient = createModelClient(
  config,
  modelUsage,
  superadminDmNotifier(discord, config.DISCORD_SUPERADMIN_USER_IDS ?? []),
);
// Owner-facing model cost lines; empty while the API client is off.
async function modelCostReport(): Promise<string> {
  if (!modelClient) return "";
  const month = budgetMonth(new Date());
  const previous = budgetMonth(new Date(month.startsAt.getTime() - 1));
  return formatModelCostReport({
    thisMonth: await modelUsage.costByFeature(month.startsAt, month.endsAt),
    lastMonth: await modelUsage.costByFeature(
      previous.startsAt,
      previous.endsAt,
    ),
    budgetMicroUsd: config.MODEL_MONTHLY_BUDGET_USD
      ? microUsdFromUsd(config.MODEL_MONTHLY_BUDGET_USD)
      : undefined,
  });
}
const agent = new RapiAgent(
  store,
  delivery,
  process.env.SUMMARY_MODEL === "off"
    ? undefined
    : config.SUMMARIZER_BACKEND === "api" && modelClient
      ? new ApiSummarizer(
          modelClient,
          `api:${config.MODEL_FOR_SUMMARY ?? config.MODEL_DEFAULT}`,
        )
      : new CodexSummarizer(process.env.SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL),
  undefined,
  config.WEBHOOK_ENCRYPTION_KEY && config.RAPI_PUBLIC_BASE_URL
    ? {
        key: briefingLinkKey(config.WEBHOOK_ENCRYPTION_KEY),
        baseUrl: config.RAPI_PUBLIC_BASE_URL,
      }
    : undefined,
);
// Without a model client (no MODEL_API_*) drafts answer "unavailable"; the
// button flow for posts the worker created works either way.
const blog = createBlogService(
  config,
  new BlogPostsStore(store),
  store,
  discord,
  modelClient ?? undefined,
);
const emailService =
  config.EMAIL_PROVIDER && config.EMAIL_API_KEY && config.EMAIL_FROM
    ? createEmailService(
        config,
        new EmailStore(store),
        new EmailDeliveryAdapter(
          createEmailTransport(config.EMAIL_PROVIDER, config.EMAIL_API_KEY, {
            postmarkStream: config.EMAIL_POSTMARK_STREAM,
          }),
          { from: config.EMAIL_FROM, replyTo: config.EMAIL_REPLY_TO },
        ),
        async (userId) => {
          await store.learnerSetEmailInterest(userId, true);
        },
      )
    : undefined;
const learner = createLearnerExperiment(
  config,
  store,
  discord,
  {
    ...(blog ? { onIssueSent: (issue) => blog.onIssueSent(issue) } : {}),
    // `web` is created below; it only exists when WEB_ENABLED is on.
    webUnsubscribeUrl: (userId) => web?.unsubscribeUrl(userId),
  },
  emailService,
);
const harnessUpdates = createHarnessUpdates(
  config,
  new HarnessUpdatesStore(store),
  discord,
);
if (config.COMMUNITY_GUILD_ID)
  agent.enableCuration(
    await createCommunityFeeds({
      store,
      summarizer: undefined,
      guildId: config.COMMUNITY_GUILD_ID,
      extraGuildIds: config.DISCORD_ALLOWED_GUILD_IDS ?? [],
      botToken: config.DISCORD_BOT_TOKEN,
      root: process.cwd(),
    }),
    config.DISCORD_SUPERADMIN_USER_IDS ?? [],
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
const homeGuildId = resolveHomeGuildId(
  config.DISCORD_HOME_GUILD_ID,
  config.COMMUNITY_GUILD_ID,
  config.DISCORD_ALLOWED_GUILD_IDS,
);
// Guild membership is checked against the gate, which also covers approved guilds.
const guildGate = createGuildGate({
  envIds: config.DISCORD_ALLOWED_GUILD_IDS,
  homeGuildId,
  load: async () =>
    (await store.allowedDiscordGuilds()).map((guild) => guild.guildId),
});
const allowlists = {
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
  guildMembersAreUsers: config.DISCORD_GUILD_MEMBERS_ARE_USERS,
  ...(homeGuildId ? { homeGuildId } : {}),
  ...(config.DISCORD_ALLOWED_CHANNEL_IDS
    ? { channelIds: config.DISCORD_ALLOWED_CHANNEL_IDS }
    : {}),
};
const commands = new DiscordCommandService(agent, allowlists, {
  // Moved commands point to the web only when the portal can actually serve them.
  ...(webEnabled(config) ? { webBaseUrl: config.RAPI_PUBLIC_BASE_URL } : {}),
  guildAllowlist: () => guildGate.allowed(),
  privacy: async (identity, options, level) =>
    executePrivacyCommand(
      identity,
      options,
      level,
      config.PRIVACY_HMAC_KEY ?? "",
      config.DATABASE_URL,
    ),
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
      const costs = await modelCostReport().catch(() => "");
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
        ...(costs ? [costs] : []),
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
      // Cost is owner information; ordinary users only see their own counts.
      const costs =
        tier === "staff" ? await modelCostReport().catch(() => "") : "";
      return [
        tier === "staff"
          ? "내 AI 사용량: 운영진 무제한"
          : `내 AI 사용량: ${usage.used}회 · 남음 ${usage.remaining}회`,
        `서버 전체: ${usage.globalUsed}회 · 남음 ${usage.globalRemaining}회`,
        `초기화: ${usage.resetAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (Asia/Seoul)`,
        ...(costs ? [costs] : []),
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
      return "AI 사용 정책을 변경했습니다.";
    },
  },
  serverConfig: {
    preview: (guildId, actorId) => layout.preview(guildId, actorId),
    apply: (guildId, actorId, planId) => layout.apply(guildId, actorId, planId),
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
});

if (process.env.REGISTER_DISCORD_COMMANDS === "true") {
  await registerSlashCommands(
    config.DISCORD_APPLICATION_ID,
    config.DISCORD_BOT_TOKEN,
    homeGuildId,
  );
}

// Off unless BILLING_ENABLED (config guarantees the keys, WEB_ENABLED and the base URL).
const billing =
  config.BILLING_ENABLED &&
  config.TOSS_CLIENT_KEY &&
  config.TOSS_SECRET_KEY &&
  config.WEBHOOK_ENCRYPTION_KEY
    ? {
        service: new BillingService({
          store: new BillingStore(store),
          toss: createTossClient({ secretKey: config.TOSS_SECRET_KEY }),
          plans: await loadBillingPlans(config.BILLING_PLANS_FILE),
          secret: config.WEBHOOK_ENCRYPTION_KEY,
        }),
        clientKey: config.TOSS_CLIENT_KEY,
        live: config.BILLING_LIVE,
      }
    : undefined;

const web = createWebPortal(
  config,
  allowlists,
  new WebStore(store),
  store,
  {
    commands,
    guilds: () => guildGate.allowed(),
    homeGuildId,
  },
  {
    // Published guides show next to sent issues in /archive; withdrawn ones never do.
    blogPosts: new BlogPostsStore(store),
    ...(billing ? { billing } : {}),
    ...(emailService
      ? {
          email: {
            status: (userId) => emailService.statusFor(userId),
            register: (userId, address) =>
              emailService.register(userId, address),
            remove: (userId) => emailService.removeAddress(userId),
          },
        }
      : {}),
  },
);

const server = createDiscordInteractionServer(
  commands,
  config.DISCORD_PUBLIC_KEY,
  {
    ...(config.WEBHOOK_SECRET
      ? { webhook: { agent, secret: config.WEBHOOK_SECRET } }
      : {}),
    ...(webhookManager ? { managedWebhook: webhookManager } : {}),
    ...(config.GITHUB_APP_ENABLED &&
    config.GITHUB_APP_WEBHOOK_SECRET &&
    config.GITHUB_APP_ALLOWED_OWNERS &&
    config.GITHUB_APP_OWNER_LOGINS
      ? {
          github: new GitHubWebhookReceiver({
            store: new GitHubStore(store),
            secret: config.GITHUB_APP_WEBHOOK_SECRET,
            policy: {
              allowedOwners: config.GITHUB_APP_ALLOWED_OWNERS,
              ownerLogins: config.GITHUB_APP_OWNER_LOGINS,
            },
          }),
        }
      : {}),
    briefing: {
      page: (batchId, token) => agent.briefingPage(batchId, token),
      feedback: (batchId, token, input) =>
        agent.recordBriefingFeedback(batchId, token, input),
      schedule: (batchId, token, input) =>
        agent.briefingSchedule(batchId, token, input),
      detail: (batchId, token, itemId) =>
        agent.briefingDetail(batchId, token, itemId),
      curation: (batchId, token, input) =>
        agent.briefingCuration(batchId, token, input),
    },
    ...(web ? { web: { handle: (request) => web.handle(request) } } : {}),
    ...(emailService && learner
      ? {
          email: {
            page: (kind, token, method) =>
              kind === "verify"
                ? emailService.verifyLink(token, method)
                : emailService.unsubscribeLink(token, method),
            webhook: (provider, headers, rawBody) =>
              emailService.webhook(provider, headers, rawBody),
            register: (userId, address) =>
              emailService.register(userId, address),
          },
        }
      : {}),
    ...(learner
      ? {
          learner: {
            handle: (identity, customId) =>
              learner.handleComponent(identity, customId),
            link: (token, userAgent) =>
              learner.resolveLink(token, new Date(), userAgent),
          },
        }
      : {}),
    ...(blog
      ? {
          blog: {
            modal: (identity, customId) => blog.reviseModal(identity, customId),
            note: (identity, customId, note) =>
              blog.handleNote(identity, customId, note),
          },
        }
      : {}),
    decision: {
      handles: (customId) =>
        isGuildDecision(customId) ||
        LearnerExperiment.handlesDecision(customId) ||
        BlogService.handles(customId) ||
        HarnessUpdateService.handles(customId),
      handle: async (identity, customId) => {
        // Pressed in the owner's DM; only a SUPERADMIN may decide.
        if (isGuildDecision(customId)) {
          assertDiscordAccess(identity, allowlists, "superadmin");
          return decideGuildButton(
            {
              decide: (guildId, status, actorId) =>
                store.decideDiscordGuild(guildId, status, actorId),
              invalidate: () => guildGate.invalidate(),
              leave: async (guildId) => {
                const left = await fetch(
                  `https://discord.com/api/v10/users/@me/guilds/${guildId}`,
                  {
                    method: "DELETE",
                    headers: {
                      authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
                    },
                    signal: AbortSignal.timeout(10_000),
                  },
                );
                await left.arrayBuffer();
                return left.ok;
              },
              registerCommands: (guildId) =>
                registerSlashCommands(
                  config.DISCORD_APPLICATION_ID,
                  config.DISCORD_BOT_TOKEN,
                  guildId,
                ),
              serverConfigUrl:
                web && config.RAPI_PUBLIC_BASE_URL
                  ? `${config.RAPI_PUBLIC_BASE_URL.replace(/\/+$/, "")}/admin/server-config`
                  : undefined,
            },
            customId,
            identity.userId,
          );
        }
        if (LearnerExperiment.handlesDecision(customId)) {
          if (!learner) return { notice: "지금은 쓸 수 없는 버튼입니다." };
          return learner.handleDecision(identity, customId);
        }
        assertDiscordAccess(identity, allowlists, "superadmin");
        if (BlogService.handles(customId)) {
          if (!blog) return { notice: "지금은 쓸 수 없는 버튼입니다." };
          return blog.handleButton(identity, customId);
        }
        if (!harnessUpdates) return { notice: "지금은 쓸 수 없는 버튼입니다." };
        return {
          result: await harnessUpdates.handleComponent(identity, customId),
        };
      },
    },
    component: async (identity, customId) => {
      if (customId.startsWith(CHATBOT_SUBSCRIPTION_PREFIX)) {
        // Any member may press their own confirm button; the id and the
        // presser must match, and only that person's subscription changes.
        if (!config.CHATBOT_ENABLED) return "지금은 쓸 수 없는 버튼입니다.";
        return handleChatbotSubscriptionComponent(store, identity, customId);
      }
      if (!identity.guildId)
        throw new Error("서버에서만 사용할 수 있는 버튼입니다.");
      if (!isGuildAllowed(identity.guildId, await guildGate.allowed()))
        throw new Error(GUILD_NOT_ALLOWED_MESSAGE);
      if (customId === "rapi_verify:v1")
        return layout.verifyMember(identity.guildId, identity.userId);
      if (customId.startsWith("server_config_apply:")) {
        const result = await commands.execute(identity, {
          name: "server_config",
          options: {
            action: "적용",
            viaButton: true,
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
