import { mkdir } from "node:fs/promises";
import WebSocket from "ws";
import { PublicAgentClient } from "@rapi/adapters";
import { PublicCommunityService } from "@rapi/agent";
import { loadEnvironment } from "@rapi/config";
import {
  assertDiscordAccess,
  createLocalHealthServer,
  splitDiscordMessage,
  summarizeReadiness,
} from "@rapi/core";
import { discordChatMessageSchema, redactChat } from "@rapi/contracts";
import { PostgresStore, ChatOpsStore } from "@rapi/db";
import { CodexExecutor, cleanupArtifacts } from "./executor.js";
import { ChatOrchestrator } from "./orchestrator.js";

const config = loadEnvironment();
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
  ...(config.DISCORD_ALLOWED_GUILD_IDS
    ? { guildIds: config.DISCORD_ALLOWED_GUILD_IDS }
    : {}),
  ...(config.DISCORD_ALLOWED_CHANNEL_IDS
    ? { channelIds: config.DISCORD_ALLOWED_CHANNEL_IDS }
    : {}),
};
const store = new PostgresStore(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
const runs = new ChatOpsStore(store);
const chatWorkspace = "/home/justn/rapi-chat";
const repository = "/home/justn/rapi-agent";
const publicAgent = new PublicAgentClient(config.PUBLIC_AGENT_SOCKET);
const publicCommunity = new PublicCommunityService(store, publicAgent);
const intents = (1 << 0) | (1 << 9) | (1 << 15);
await mkdir(chatWorkspace, { recursive: true });
// One Gateway owner per database. Losing this session stops execution.
const lease = await store.pool.connect();
const lock = await lease.query<{ acquired: boolean }>(
  "SELECT pg_try_advisory_lock(731904226) AS acquired",
);
if (!lock.rows[0]?.acquired) throw new Error("ChatOps instance already active");
await runs.recover();
await cleanupArtifacts(chatWorkspace);
const chat = new ChatOrchestrator(
  runs,
  new CodexExecutor(repository, chatWorkspace),
  async (channel, content) => {
    for (const chunk of splitDiscordMessage(redactChat(content)))
      await sendMessage(channel, chunk);
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
      return publicCommunity.answer({
        guildId: input.guildId,
        userId: input.userId,
        requestId: input.requestId,
        tier: input.tier,
        text: input.text,
      });
    },
  },
);
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
    signal: AbortSignal.timeout(10000),
    headers,
  });
  if (!response.ok) throw new Error(`Discord API returned ${response.status}`);
  return response;
}

async function sendMessage(
  channelId: string,
  content: string,
): Promise<string> {
  const response = await discordRequest(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
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
    !message.content.trimStart().startsWith("라피야!") ||
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
    } else if (payload.op === 0 && payload.t === "READY") {
      const ready = payload.d as {
        session_id: string;
        resume_gateway_url: string;
      };
      sessionId = ready.session_id;
      resumeUrl = ready.resume_gateway_url;
      gatewayReady = true;
      process.stdout.write("rapi-chat connected to Discord Gateway\n");
    } else if (payload.op === 0 && payload.t === "MESSAGE_CREATE") {
      void enqueue(payload.d).catch(() =>
        process.stderr.write("ChatOps request failed\n"),
      );
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
        required: true,
        ...(publicAgentReady ? {} : { reason: "public agent unavailable" }),
      },
    ]);
  },
);

const shutdown = (): void => {
  stopped = true;
  if (heartbeat) clearInterval(heartbeat);
  if (heartbeatStart) clearTimeout(heartbeatStart);
  if (reconnect) clearTimeout(reconnect);
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
