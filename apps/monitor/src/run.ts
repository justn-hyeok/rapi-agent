import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DiscordWebhookClient, decryptSecret } from "@rapi/adapters";
import { loadEnvironment } from "@rapi/config";
import {
  assessBackupStatus,
  createLocalHealthServer,
  HealthTransitionTracker,
  summarizeReadiness,
  type ComponentHealth,
} from "@rapi/core";
import { PostgresStore } from "@rapi/db";

interface PendingAlert {
  id: string;
  content: string;
}

interface MonitorState {
  tracker: ReturnType<HealthTransitionTracker["snapshot"]>;
  components: ComponentHealth[];
  pendingAlerts: PendingAlert[];
  capacityLevel: 0 | 80 | 90;
  lastCapacityCheckAt?: string;
  updatedAt: string;
}

const config = loadEnvironment();
const store = new PostgresStore(config.DATABASE_URL, {
  max: 1,
  connectionTimeoutMs: 3000,
  queryTimeoutMs: 3000,
});
const tracker = new HealthTransitionTracker(3, 2);
const state = await loadState(config.MONITOR_STATE_FILE);
tracker.restore(state.tracker);
let checking = false;
let stopped = false;
const discordWebhook = new DiscordWebhookClient();

async function loadState(file: string): Promise<MonitorState> {
  try {
    const parsed = JSON.parse(
      await readFile(file, "utf8"),
    ) as Partial<MonitorState>;
    return {
      tracker: parsed.tracker ?? {},
      components: parsed.components ?? [],
      pendingAlerts: parsed.pendingAlerts ?? [],
      capacityLevel: parsed.capacityLevel ?? 0,
      ...(parsed.lastCapacityCheckAt
        ? { lastCapacityCheckAt: parsed.lastCapacityCheckAt }
        : {}),
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return {
      tracker: {},
      components: [],
      pendingAlerts: [],
      capacityLevel: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
}

async function saveState(): Promise<void> {
  const target = config.MONITOR_STATE_FILE;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  state.tracker = tracker.snapshot();
  state.updatedAt = new Date().toISOString();
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, target);
}

async function checkEndpoint(
  name: string,
  url: string,
): Promise<ComponentHealth> {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  const previous = state.components.find(
    (component) => component.name === name,
  );
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    await response.arrayBuffer();
    return {
      name,
      status: response.ok ? "ok" : "failed",
      checkedAt,
      required: true,
      latencyMs: Math.round(performance.now() - started),
      ...(response.ok
        ? { lastSuccessAt: checkedAt }
        : {
            reason: `HTTP ${response.status}`,
            ...(previous?.lastSuccessAt
              ? { lastSuccessAt: previous.lastSuccessAt }
              : {}),
          }),
    };
  } catch {
    return {
      name,
      status: "failed",
      checkedAt,
      required: true,
      latencyMs: Math.round(performance.now() - started),
      reason: "endpoint unavailable",
      ...(previous?.lastSuccessAt
        ? { lastSuccessAt: previous.lastSuccessAt }
        : {}),
    };
  }
}

async function checkBackup(): Promise<ComponentHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const status = JSON.parse(
      await readFile(config.BACKUP_STATUS_FILE, "utf8"),
    ) as {
      state?: "success" | "failed";
      lastSuccessAt?: string;
      lastFailureAt?: string;
    };
    const assessment = assessBackupStatus(status, new Date(checkedAt));
    return {
      name: "backup",
      status: assessment.healthy ? "ok" : "failed",
      checkedAt,
      required: true,
      ...(assessment.lastSuccessAt
        ? { lastSuccessAt: assessment.lastSuccessAt }
        : {}),
      ...(assessment.reason ? { reason: assessment.reason } : {}),
    };
  } catch {
    return {
      name: "backup",
      status: "failed",
      checkedAt,
      required: true,
      reason: "backup success marker is missing",
    };
  }
}

async function checkDatabaseCapacity(
  now: Date,
): Promise<ComponentHealth | undefined> {
  if (
    state.lastCapacityCheckAt &&
    now.getTime() - new Date(state.lastCapacityCheckAt).getTime() < 15 * 60_000
  ) {
    const cached = state.components.find(
      (component) => component.name === "database_capacity",
    );
    return cached
      ? {
          ...cached,
          checkedAt: now.toISOString(),
          details: {
            ...cached.details,
            measuredAt: cached.checkedAt,
          },
        }
      : undefined;
  }
  state.lastCapacityCheckAt = now.toISOString();
  try {
    const result = await store.checkHealth();
    const percent =
      (result.clusterDatabaseBytes / config.DATABASE_SIZE_LIMIT_BYTES) * 100;
    const level: 0 | 80 | 90 = percent >= 90 ? 90 : percent >= 80 ? 80 : 0;
    if (level !== state.capacityLevel) {
      const content =
        level === 0
          ? `[라피 복구] DB 사용량이 정상 범위로 돌아왔습니다: ${percent.toFixed(1)}%`
          : `[라피 경고] DB 사용량이 ${level}% 기준에 진입했습니다: ${percent.toFixed(1)}%`;
      state.pendingAlerts.push({
        id: `capacity:${level}:${now.toISOString()}`,
        content,
      });
      state.capacityLevel = level;
    }
    return {
      name: "database_capacity",
      status: level === 90 ? "failed" : "ok",
      checkedAt: now.toISOString(),
      required: false,
      details: {
        databaseBytes: result.databaseBytes,
        clusterDatabaseBytes: result.clusterDatabaseBytes,
        differenceBytes: result.clusterDatabaseBytes - result.databaseBytes,
        configuredLimitBytes: config.DATABASE_SIZE_LIMIT_BYTES,
        percent: Number(percent.toFixed(1)),
        note: "percent는 Supabase Database Reports와 대응하는 전체 DB 크기 합계 기준이며 WAL·로그 disk size는 별도입니다.",
      },
    };
  } catch {
    return {
      name: "database_capacity",
      status: "unknown",
      checkedAt: now.toISOString(),
      required: false,
      reason: "database size unavailable",
    };
  }
}

async function sendAlert(content: string): Promise<void> {
  const encrypted = config.OPERATIONS_DISCORD_WEBHOOK_CIPHERTEXT;
  const webhookUrl = encrypted
    ? decryptSecret(encrypted, config.WEBHOOK_ENCRYPTION_KEY ?? "")
    : config.OPERATIONS_DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    await discordWebhook.send(webhookUrl, content);
    return;
  }
  if (!config.OPERATIONS_CHANNEL_ID)
    throw new Error("operations alert destination is not configured");
  const response = await fetch(
    `https://discord.com/api/v10/channels/${config.OPERATIONS_CHANNEL_ID}/messages`,
    {
      method: "POST",
      signal: AbortSignal.timeout(3000),
      headers: {
        authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    },
  );
  if (!response.ok) throw new Error(`Discord returned ${response.status}`);
  await response.arrayBuffer();
}

async function flushAlerts(): Promise<void> {
  while (state.pendingAlerts[0]) {
    await sendAlert(state.pendingAlerts[0].content);
    state.pendingAlerts.shift();
    await saveState();
  }
}

async function check(): Promise<void> {
  if (checking || stopped) return;
  checking = true;
  try {
    const now = new Date();
    const endpoints = await Promise.all([
      checkEndpoint("bot", config.BOT_READY_URL),
      checkEndpoint("chat", config.CHAT_READY_URL),
      checkEndpoint("worker", config.WORKER_READY_URL),
      checkEndpoint("omp", config.OMP_READY_URL),
      checkEndpoint("public_agent", config.PUBLIC_AGENT_READY_URL),
      checkEndpoint("public_gateway", config.PUBLIC_GATEWAY_READY_URL),
      checkEndpoint("cloudflare_tunnel", config.CLOUDFLARE_TUNNEL_READY_URL),
      checkBackup(),
    ]);
    const capacity = await checkDatabaseCapacity(now);
    state.components = [...endpoints, ...(capacity ? [capacity] : [])];
    for (const component of endpoints) {
      const transition = tracker.observe(
        component.name,
        component.status === "ok",
      );
      if (transition)
        state.pendingAlerts.push({
          id: `${component.name}:${transition}:${now.toISOString()}`,
          content:
            transition === "down"
              ? `[라피 장애] ${component.name}: ${component.reason ?? "응답 없음"}`
              : `[라피 복구] ${component.name} 상태가 정상으로 돌아왔습니다.`,
        });
    }
    await saveState();
    await flushAlerts().catch(() => undefined);
  } finally {
    checking = false;
  }
}

const healthServer = createLocalHealthServer(config.MONITOR_PORT, async () =>
  summarizeReadiness(
    state.components,
    new Date(),
    config.MONITOR_INTERVAL_SECONDS * 3000,
  ),
);
await check();
const timer = setInterval(
  () => void check(),
  config.MONITOR_INTERVAL_SECONDS * 1000,
);

const shutdown = (): void => {
  stopped = true;
  clearInterval(timer);
  healthServer.close();
  void store.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
