import { mkdir, readFile } from "node:fs/promises";
import WebSocket from "ws";
import {
  DiscordDeliveryAdapter,
  GitHubAppClient,
  PublicAgentClient,
  createModelClient,
  createPublicQaMeter,
  superadminDmNotifier,
  AgentResearchBrowser,
  loadResearchPolicy,
} from "@rapi/adapters";
import {
  ChatbotService,
  PublicCommunityService,
  createBlogService,
  createGithubRepoReader,
  BrowserResearchService,
  RapiAgent,
} from "@rapi/agent";
import { loadEnvironment } from "@rapi/config";
import {
  assertDiscordAccess,
  createGuildGate,
  createLocalHealthServer,
  decideGuildAdmission,
  isGuildAllowed,
  resolveHomeGuildId,
  splitDiscordMessage,
  summarizeReadiness,
} from "@rapi/core";
import {
  discordChatMessageSchema,
  parseRapiInvocation,
  redactChat,
} from "@rapi/contracts";
import {
  BlogPostsStore,
  ChatbotStore,
  PostgresStore,
  ChatOpsStore,
  GitHubStore,
  ModelUsageStore,
  BrowserResearchStore,
} from "@rapi/db";
import { CodexExecutor, cleanupArtifacts } from "./executor.js";
import { ChatOrchestrator } from "./orchestrator.js";
import { establishesGatewaySession } from "./gateway-state.js";
import { DiscordTyping } from "./typing.js";
import { countDirectReply, isDirectMessage } from "./direct-message.js";
import {
  GitHubIntake,
  cleanupGithubClones,
  githubSender,
  githubWorkspaces,
} from "./github.js";

const config = loadEnvironment();
const homeGuildId = resolveHomeGuildId(
  config.DISCORD_HOME_GUILD_ID,
  config.COMMUNITY_GUILD_ID,
  config.DISCORD_ALLOWED_GUILD_IDS,
);
const discordAccess = {
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
const store = new PostgresStore(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
const guildGate = createGuildGate({
  envIds: config.DISCORD_ALLOWED_GUILD_IDS,
  homeGuildId,
  load: async () =>
    (await store.allowedDiscordGuilds()).map((guild) => guild.guildId),
});
const runs = new ChatOpsStore(store);
const chatWorkspace = "/home/justn/rapi-chat";
const repository = "/home/justn/rapi-agent";
const discord = new DiscordDeliveryAdapter(config.DISCORD_BOT_TOKEN);
const modelUsage = new ModelUsageStore(store);
// Null unless MODEL_API_BASE_URL and MODEL_API_KEY are set.
const modelClient = createModelClient(
  config,
  modelUsage,
  superadminDmNotifier(discord, config.DISCORD_SUPERADMIN_USER_IDS ?? []),
);
const publicAgent = new PublicAgentClient(config.PUBLIC_AGENT_SOCKET);
const chatbotStore = new ChatbotStore(store, config.RAPI_PUBLIC_BASE_URL);
const chatbot = config.CHATBOT_ENABLED
  ? new ChatbotService(chatbotStore, store, {
      l2Enabled: config.CHATBOT_L2_ENABLED,
      readRepo: createGithubRepoReader(),
    })
  : undefined;
const publicCommunity = new PublicCommunityService(
  store,
  publicAgent,
  config.PUBLIC_AGENT_ENABLED,
  chatbot,
  createPublicQaMeter(config, modelUsage),
);
// DIRECT_MESSAGES is requested only for the learner experiment, which counts replies.
const intents =
  (1 << 0) |
  (1 << 9) |
  (1 << 15) |
  (config.LEARNER_EXPERIMENT_ENABLED ? 1 << 12 : 0);
await mkdir(chatWorkspace, { recursive: true });
// One Gateway owner per database. Losing this session stops execution.
const lease = await store.pool.connect();
const lock = await lease.query<{ acquired: boolean }>(
  "SELECT pg_try_advisory_lock(731904226) AS acquired",
);
if (!lock.rows[0]?.acquired) throw new Error("ChatOps instance already active");
await runs.recover();
await cleanupArtifacts(chatWorkspace);
const executorOptions = {
  harness: config.CHATOPS_HARNESS,
  senpiBinary: config.SENPI_BIN,
  senpiHome: config.SENPI_HOME,
};
const executor = new CodexExecutor(repository, chatWorkspace, executorOptions);
// GitHub App (off unless explicitly enabled): requests arrive through the
// webhook inbox and run through this same orchestrator.
const githubPolicy =
  config.GITHUB_APP_ENABLED &&
  config.GITHUB_APP_ID &&
  config.GITHUB_APP_PRIVATE_KEY_PATH &&
  config.GITHUB_APP_ALLOWED_OWNERS &&
  config.GITHUB_APP_OWNER_LOGINS
    ? {
        allowedOwners: config.GITHUB_APP_ALLOWED_OWNERS,
        ownerLogins: config.GITHUB_APP_OWNER_LOGINS,
      }
    : undefined;
const githubApp = githubPolicy
  ? new GitHubAppClient({
      appId: config.GITHUB_APP_ID!,
      privateKey: await readFile(config.GITHUB_APP_PRIVATE_KEY_PATH!, "utf8"),
    })
  : undefined;
const githubStore = githubApp ? new GitHubStore(store) : undefined;
const sendGithub = githubApp ? githubSender(githubApp) : undefined;
if (githubApp) {
  await githubStore!.failClaimed();
  await cleanupGithubClones(chatWorkspace);
}
const chat = new ChatOrchestrator(
  runs,
  executor,
  async (channel, content, components) => {
    if (sendGithub && channel.startsWith("github:")) {
      await sendGithub(channel, content);
      return;
    }
    const chunks = splitDiscordMessage(redactChat(content));
    for (const [index, chunk] of chunks.entries())
      await sendMessage(
        channel,
        chunk,
        // Buttons belong under the last part of a long reply.
        index === chunks.length - 1 ? components : undefined,
      );
  },
  {
    isAdminChannel: async (scope) => {
      const configured = config.RAPI_ADMIN_CHANNEL_ID;
      const managed = await store.managedDiscordResourceId(
        scope.guild,
        "channel",
        "rapi_admin",
      );
      return scope.channel === (configured ?? managed);
    },
    answer: async (input) => {
      return publicCommunity.converse({
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.userId,
        requestId: input.requestId,
        tier: input.tier,
        text: input.text,
      });
    },
  },
  new DiscordTyping(async (channel, signal) => {
    await discordRequest(`/channels/${channel}/typing`, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
  }),
  homeGuildId,
  githubApp && githubStore && githubPolicy
    ? githubWorkspaces({
        app: githubApp,
        store: githubStore,
        policy: githubPolicy,
        workspace: chatWorkspace,
        executorOptions,
      })
    : undefined,
  // Drafts use the same metered model client as the bot; without MODEL_API_*
  // the service answers that drafts are unavailable.
  createBlogService(
    { ...config, BLOG_PUBLISH_ENABLED: false },
    new BlogPostsStore(store),
    store,
    discord,
    modelClient ?? undefined,
  ),
  new BrowserResearchService({
    enabled: config.BROWSER_RESEARCH_ENABLED,
    owners: config.DISCORD_SUPERADMIN_USER_IDS ?? [],
    homeGuildId,
    model: modelClient,
    store: new BrowserResearchStore(store),
    ingest: new RapiAgent(store, discord),
    policy: loadResearchPolicy,
    browser: (site, policy, signal) =>
      new AgentResearchBrowser({
        site,
        policy,
        signal,
        binary: config.BROWSER_RESEARCH_BIN,
        authDirectory: config.BROWSER_RESEARCH_AUTH_DIR,
      }),
  }),
);
const intake =
  githubApp && githubStore && githubPolicy
    ? new GitHubIntake({
        store: githubStore,
        app: githubApp,
        chat,
        policy: githubPolicy,
      })
    : undefined;
let intakeBusy = false;
const intakeTimer = intake
  ? setInterval(() => {
      if (intakeBusy) return;
      intakeBusy = true;
      void (async () => {
        while (await intake.runOnce());
      })()
        .catch(() => process.stderr.write("GitHub intake failed\n"))
        .finally(() => {
          intakeBusy = false;
        });
    }, 3000)
  : undefined;
lease.on("error", () => {
  void chat.shutdown().finally(() => process.exit(1));
});

async function discordRequest(
  route: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${config.DISCORD_BOT_TOKEN}`);
  headers.set("content-type", "application/json");
  const response = await fetch(`https://discord.com/api/v10${route}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10000),
    headers,
  });
  if (!response.ok) throw new Error(`Discord API returned ${response.status}`);
  return response;
}

async function sendMessage(
  channelId: string,
  content: string,
  components?: unknown[],
): Promise<string> {
  const response = await discordRequest(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
      ...(components?.length ? { components } : {}),
    }),
  });
  const message = (await response.json()) as { id: string };
  return message.id;
}

const roleCache = new Map<
  string,
  { expiresAt: number; permissions: Map<string, bigint> }
>();

async function guildPermissions(
  guildId: string,
  roleIds: readonly string[],
): Promise<string> {
  let cached = roleCache.get(guildId);
  if (!cached || cached.expiresAt <= Date.now()) {
    const response = await discordRequest(`/guilds/${guildId}/roles`);
    const roles = (await response.json()) as Array<{
      id: string;
      permissions: string;
    }>;
    cached = {
      expiresAt: Date.now() + 60_000,
      permissions: new Map(
        roles.map((role) => [role.id, BigInt(role.permissions)]),
      ),
    };
    roleCache.set(guildId, cached);
  }
  let permissions = cached.permissions.get(guildId) ?? 0n;
  for (const roleId of roleIds)
    permissions |= cached.permissions.get(roleId) ?? 0n;
  return permissions.toString();
}

async function enqueue(raw: unknown): Promise<void> {
  const parsed = discordChatMessageSchema.safeParse(raw);
  if (!parsed.success) return;
  const message = parsed.data;
  if (
    message.author.bot ||
    !message.guild_id ||
    parseRapiInvocation(message.content) === null ||
    !isGuildAllowed(message.guild_id, await guildGate.allowed()) ||
    !(await store.chatChannelEnabled(message.guild_id, message.channel_id))
  )
    return;
  let accessLevel;
  try {
    const roles = message.member?.roles ?? [];
    accessLevel = assertDiscordAccess(
      {
        userId: message.author.id,
        guildId: message.guild_id,
        channelId: message.channel_id,
        roleIds: roles,
        guildPermissions: await guildPermissions(message.guild_id, roles),
      },
      discordAccess,
    );
  } catch {
    return;
  }
  await chat.receive(message, accessLevel);
}

async function askGuildApproval(guildId: string, name: string): Promise<void> {
  const owners = new Set([
    ...config.DISCORD_ALLOWED_USER_IDS,
    ...(config.DISCORD_SUPERADMIN_USER_IDS ?? []),
  ]);
  for (const owner of owners) {
    try {
      const channel = (await (
        await discordRequest("/users/@me/channels", {
          method: "POST",
          body: JSON.stringify({ recipient_id: owner }),
        })
      ).json()) as { id: string };
      await discordRequest(`/channels/${channel.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: `라피가 새 서버에 초대됐습니다: ${name} (${guildId})\n허용하기 전까지 이 서버에서는 응답하지 않습니다.`,
          allowed_mentions: { parse: [] },
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 3,
                  label: "허용",
                  custom_id: `guild_allow:${guildId}`,
                },
                {
                  type: 2,
                  style: 4,
                  label: "거절",
                  custom_id: `guild_reject:${guildId}`,
                },
              ],
            },
          ],
        }),
      });
    } catch {
      process.stderr.write("Guild approval request could not be delivered\n");
    }
  }
}

async function guildCreated(raw: unknown): Promise<void> {
  const guild = raw as { id?: unknown; name?: unknown; unavailable?: boolean };
  if (typeof guild.id !== "string" || guild.unavailable) return;
  const action = decideGuildAdmission(
    guild.id,
    config.DISCORD_ALLOWED_GUILD_IDS,
    await store.discordGuildStatus(guild.id),
  );
  if (action === "leave") {
    await discordRequest(`/users/@me/guilds/${guild.id}`, { method: "DELETE" });
  } else if (
    action === "request" &&
    (await store.requestDiscordGuild(
      guild.id,
      typeof guild.name === "string" ? guild.name : guild.id,
    ))
  ) {
    await askGuildApproval(
      guild.id,
      typeof guild.name === "string" ? guild.name : guild.id,
    );
  }
}

async function guildDeleted(raw: unknown): Promise<void> {
  const guild = raw as { id?: unknown; unavailable?: boolean };
  if (typeof guild.id !== "string" || guild.unavailable) return;
  await store.markDiscordGuildLeft(guild.id);
}

let socket: WebSocket | undefined;
let sequence: number | null = null;
let sessionId: string | undefined;
let resumeUrl = "wss://gateway.discord.gg";
let heartbeat: NodeJS.Timeout | undefined;
let heartbeatStart: NodeJS.Timeout | undefined;
let reconnect: NodeJS.Timeout | undefined;
let stopped = false;
let awaitingHeartbeat = false;
let gatewayReady = false;

function send(payload: unknown): void {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(payload));
}

function scheduleReconnect(delay = 2000): void {
  if (stopped || reconnect) return;
  reconnect = setTimeout(() => {
    reconnect = undefined;
    connect();
  }, delay);
}

function connect(): void {
  const url = `${resumeUrl}/?v=10&encoding=json`;
  socket = new WebSocket(url);
  socket.on("message", (raw) => {
    const rawText = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.from(raw).toString("utf8");
    const payload = JSON.parse(rawText) as {
      op: number;
      d: unknown;
      s?: number | null;
      t?: string;
    };
    if (payload.s !== undefined && payload.s !== null) sequence = payload.s;
    if (payload.op === 10) {
      const interval = (payload.d as { heartbeat_interval: number })
        .heartbeat_interval;
      if (heartbeat) clearInterval(heartbeat);
      if (heartbeatStart) clearTimeout(heartbeatStart);
      const beat = (): void => {
        if (awaitingHeartbeat) socket?.terminate();
        awaitingHeartbeat = true;
        send({ op: 1, d: sequence });
      };
      heartbeatStart = setTimeout(beat, Math.floor(Math.random() * interval));
      heartbeatStart.unref();
      heartbeat = setInterval(beat, interval);
      if (sessionId) {
        send({
          op: 6,
          d: {
            token: config.DISCORD_BOT_TOKEN,
            session_id: sessionId,
            seq: sequence,
          },
        });
      } else {
        send({
          op: 2,
          d: {
            token: config.DISCORD_BOT_TOKEN,
            intents,
            properties: {
              os: process.platform,
              browser: "rapi-chatops",
              device: "rapi-chatops",
            },
          },
        });
      }
    } else if (payload.op === 11) {
      awaitingHeartbeat = false;
    } else if (payload.op === 1) {
      send({ op: 1, d: sequence });
    } else if (payload.op === 7) {
      socket?.terminate();
    } else if (payload.op === 9) {
      if (payload.d === false) {
        sessionId = undefined;
        sequence = null;
      }
      socket?.terminate();
    } else if (payload.op === 0 && establishesGatewaySession(payload.t)) {
      if (payload.t === "READY") {
        const ready = payload.d as {
          session_id: string;
          resume_gateway_url: string;
        };
        sessionId = ready.session_id;
        resumeUrl = ready.resume_gateway_url;
      }
      gatewayReady = true;
      process.stdout.write(
        `rapi-chat ${payload.t === "RESUMED" ? "resumed" : "connected"} Discord Gateway session\n`,
      );
    } else if (payload.op === 0 && payload.t === "GUILD_CREATE") {
      void guildCreated(payload.d).catch(() =>
        process.stderr.write("Guild admission failed\n"),
      );
    } else if (payload.op === 0 && payload.t === "GUILD_DELETE") {
      void guildDeleted(payload.d).catch(() =>
        process.stderr.write("Guild removal failed\n"),
      );
    } else if (payload.op === 0 && payload.t === "MESSAGE_CREATE") {
      const work =
        config.LEARNER_EXPERIMENT_ENABLED && isDirectMessage(payload.d)
          ? countDirectReply(payload.d, (userId) =>
              store.learnerRecordReply(userId),
            )
          : enqueue(payload.d);
      void work.catch(() => process.stderr.write("ChatOps request failed\n"));
    }
  });
  socket.on("close", (code) => {
    gatewayReady = false;
    if (heartbeat) clearInterval(heartbeat);
    if (heartbeatStart) clearTimeout(heartbeatStart);
    heartbeat = undefined;
    heartbeatStart = undefined;
    awaitingHeartbeat = false;
    if (code === 4004 || code === 4014) {
      process.stderr.write(`Discord Gateway rejected the bot: ${code}\n`);
      return;
    }
    scheduleReconnect();
  });
  socket.on("error", (error) => {
    process.stderr.write(`Discord Gateway error: ${error.message}\n`);
  });
}

connect();
const healthServer = createLocalHealthServer(
  config.CHAT_HEALTH_PORT,
  async () => {
    const db = await store.checkHealth();
    const publicAgentReady = await publicAgent.readiness();
    const harnesses = await executor.readiness();
    const senpiReady = harnesses.senpi.binary && harnesses.senpi.configured;
    const now = new Date();
    return summarizeReadiness([
      {
        name: "database",
        status: "ok",
        checkedAt: now.toISOString(),
        required: true,
        latencyMs: db.latencyMs,
      },
      {
        name: "discord_gateway",
        status: gatewayReady ? "ok" : "failed",
        checkedAt: now.toISOString(),
        required: true,
        ...(gatewayReady ? {} : { reason: "gateway disconnected" }),
      },
      {
        name: "public_agent",
        status: publicAgentReady ? "ok" : "failed",
        checkedAt: now.toISOString(),
        required: config.PUBLIC_AGENT_ENABLED,
        ...(publicAgentReady ? {} : { reason: "public agent unavailable" }),
      },
      {
        name: "codex",
        status: harnesses.codex.binary ? "ok" : "failed",
        checkedAt: now.toISOString(),
        required: config.CHATOPS_HARNESS === "codex",
        ...(harnesses.codex.binary ? {} : { reason: "codex binary missing" }),
      },
      {
        name: "senpi",
        status: senpiReady ? "ok" : "failed",
        checkedAt: now.toISOString(),
        required: config.CHATOPS_HARNESS === "senpi",
        ...(senpiReady
          ? {}
          : {
              reason: harnesses.senpi.binary
                ? "senpi settings missing"
                : "senpi binary missing",
            }),
      },
    ]);
  },
);

const shutdown = (): void => {
  stopped = true;
  if (heartbeat) clearInterval(heartbeat);
  if (heartbeatStart) clearTimeout(heartbeatStart);
  if (reconnect) clearTimeout(reconnect);
  if (intakeTimer) clearInterval(intakeTimer);
  socket?.close(1000);
  healthServer.close();
  void chat.shutdown().finally(async () => {
    lease.release();
    await store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
