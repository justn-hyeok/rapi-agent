import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { loadEnvironment } from "@rapi/config";
import { splitDiscordMessage } from "@rapi/core";
import { PostgresStore } from "@rapi/db";

const config = loadEnvironment();
const store = new PostgresStore(config.DATABASE_URL);
const chatWorkspace = "/home/justn/rapi-chat";
const repository = "/home/justn/rapi-agent";
const prefix = "라피야!";
const model = "gpt-6-astra";
const intents = (1 << 0) | (1 << 9) | (1 << 15);

await mkdir(chatWorkspace, { recursive: true });

function codexEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const upper = key.toUpperCase();
      return !(
        upper.includes("TOKEN") ||
        upper.includes("SECRET") ||
        upper.includes("PASSWORD") ||
        upper.includes("API_KEY") ||
        upper === "DATABASE_URL"
      );
    }),
  );
}

async function answerWithCodex(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  const outputPath = path.join(chatWorkspace, `${randomUUID()}.txt`);
  const prompt = [
    "너는 개인 Discord ChatOps 비서 라피다.",
    "항상 자연스러운 한국어로 직접 답한다.",
    "일반 질문, 서버 운영, 현재 코드베이스 질문에 모두 답한다.",
    "간결하게 답하되 필요한 명령이나 근거는 구체적으로 쓴다.",
    "허용된 사용자가 요청한 서버 운영, 코드 수정, 테스트, 배포 작업은 필요한 도구를 사용해 직접 끝까지 수행한다.",
    "비밀값과 인증 정보는 읽거나 답변에 노출하지 않는다.",
    "현재 대화:",
    ...messages.map((message) =>
      message.role === "user"
        ? `사용자: ${message.content}`
        : `라피: ${message.content}`,
    ),
    "라피:",
  ].join("\n\n");

  const result = await new Promise<{ code: number; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        "/usr/local/bin/codex",
        [
          "exec",
          "--ignore-user-config",
          "--ephemeral",
          "--model",
          model,
          "--dangerously-bypass-approvals-and-sandbox",
          "--color",
          "never",
          "--output-last-message",
          outputPath,
          "-C",
          repository,
          "-",
        ],
        {
          env: codexEnvironment(),
          stdio: ["pipe", "ignore", "pipe"],
        },
      );
      const errors: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.on("error", reject);
      const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000);
      timeout.unref();
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({
          code: code ?? 1,
          stderr: Buffer.concat(errors).toString("utf8"),
        });
      });
      child.stdin.end(prompt);
    },
  );
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim().split("\n").at(-1) ?? "Codex 응답 실패",
    );
  return (await readFile(outputPath, "utf8")).trim();
}

async function discordRequest(
  route: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${config.DISCORD_BOT_TOKEN}`);
  headers.set("content-type", "application/json");
  const response = await fetch(`https://discord.com/api/v10${route}`, {
    ...init,
    headers,
  });
  if (!response.ok) throw new Error(`Discord API returned ${response.status}`);
  return response;
}

async function sendTyping(channelId: string): Promise<void> {
  await discordRequest(`/channels/${channelId}/typing`, { method: "POST" });
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

type MessageEvent = {
  id: string;
  guild_id?: string;
  channel_id: string;
  content: string;
  author: { id: string; bot?: boolean };
};

const channelQueues = new Map<string, Promise<void>>();

function enqueue(message: MessageEvent): void {
  const previous = channelQueues.get(message.channel_id) ?? Promise.resolve();
  const next = previous
    .then(() => handleMessage(message))
    .catch((error: unknown) => {
      process.stderr.write(
        `ChatOps error: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    })
    .finally(() => {
      if (channelQueues.get(message.channel_id) === next)
        channelQueues.delete(message.channel_id);
    });
  channelQueues.set(message.channel_id, next);
}

async function handleMessage(message: MessageEvent): Promise<void> {
  if (
    message.author.bot ||
    !message.guild_id ||
    !config.DISCORD_ALLOWED_USER_IDS.includes(message.author.id) ||
    !message.content.trimStart().startsWith(prefix) ||
    !(await store.chatChannelEnabled(message.guild_id, message.channel_id))
  )
    return;

  const question = message.content.trimStart().slice(prefix.length).trim();
  if (!question) {
    await sendMessage(message.channel_id, "응. `라피야!` 뒤에 질문을 적어줘.");
    return;
  }
  const inserted = await store.appendChatMessage({
    guildId: message.guild_id,
    channelId: message.channel_id,
    discordMessageId: message.id,
    authorId: message.author.id,
    role: "user",
    content: question,
  });
  if (!inserted) return;

  await sendTyping(message.channel_id);
  const typing = setInterval(() => {
    void sendTyping(message.channel_id).catch(() => undefined);
  }, 8000);
  try {
    const context = await store.recentChatMessages(message.channel_id);
    const answer = await answerWithCodex(context);
    const chunks = splitDiscordMessage(answer || "답변을 만들지 못했습니다.");
    let responseId: string | undefined;
    for (const chunk of chunks) {
      responseId = await sendMessage(message.channel_id, chunk);
    }
    await store.appendChatMessage({
      guildId: message.guild_id,
      channelId: message.channel_id,
      ...(responseId ? { discordMessageId: responseId } : {}),
      authorId: config.DISCORD_APPLICATION_ID,
      role: "assistant",
      content: answer,
    });
  } finally {
    clearInterval(typing);
  }
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
      process.stdout.write("rapi-chat connected to Discord Gateway\n");
    } else if (payload.op === 0 && payload.t === "MESSAGE_CREATE") {
      enqueue(payload.d as MessageEvent);
    }
  });
  socket.on("close", (code) => {
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

const shutdown = (): void => {
  stopped = true;
  if (heartbeat) clearInterval(heartbeat);
  if (heartbeatStart) clearTimeout(heartbeatStart);
  if (reconnect) clearTimeout(reconnect);
  socket?.close(1000);
  void store.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
