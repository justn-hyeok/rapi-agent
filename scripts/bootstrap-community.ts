import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DiscordLayoutManager, WebhookManager } from "@rapi/agent";
import {
  decryptSecret,
  encryptSecret,
  parseDiscordWebhookUrl,
} from "@rapi/adapters";
import { loadEnvironment } from "@rapi/config";
import { PostgresStore } from "@rapi/db";
import { replaceEnvironmentValue } from "./update-discord-token.mjs";

const officialFeeds = [
  "https://openai.com/news/rss.xml",
  "https://github.blog/changelog/feed/",
  "https://blog.cloudflare.com/rss/",
  "https://supabase.com/rss.xml",
] as const;

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

async function updateEnvironment(
  values: Record<string, string>,
): Promise<void> {
  const target = resolve(process.env.RAPI_ENV_FILE ?? ".env");
  let contents = await readFile(target, "utf8");
  for (const [name, value] of Object.entries(values))
    contents = replaceEnvironmentValue(contents, name, value);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

const config = loadEnvironment();
const guildId =
  config.COMMUNITY_GUILD_ID ?? config.DISCORD_ALLOWED_GUILD_IDS?.[0];
if (!guildId)
  throw new Error("COMMUNITY_GUILD_ID 또는 허용 guild ID가 필요합니다.");
if (!config.WEBHOOK_ENCRYPTION_KEY || !config.RAPI_PUBLIC_BASE_URL)
  throw new Error("고정 공개 주소와 WEBHOOK_ENCRYPTION_KEY가 먼저 필요합니다.");

const store = new PostgresStore(config.DATABASE_URL, {
  max: 2,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
const layout = new DiscordLayoutManager(store, {
  botToken: config.DISCORD_BOT_TOKEN,
  layoutFile: config.DISCORD_LAYOUT_FILE,
});
const manager = new WebhookManager(store, {
  encryptionKey: config.WEBHOOK_ENCRYPTION_KEY,
  publicBaseUrl: config.RAPI_PUBLIC_BASE_URL,
  verifyChannel: async (expectedGuild, channelId) => {
    try {
      const channel = await layout.rest.request<{ guild_id?: string }>(
        `/channels/${channelId}`,
      );
      return channel.guild_id === expectedGuild;
    } catch {
      return false;
    }
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
});

async function ensureOutbound(
  name: string,
  channelKey: string,
): Promise<string> {
  const existing = await store.webhookConnectionByName(guildId!, name);
  if (existing) {
    if (existing.kind !== "discord_outbound")
      throw new Error(`${name} 이름이 다른 웹훅 유형에 사용 중입니다.`);
    return existing.id;
  }
  const url = await layout.createWebhook(guildId!, channelKey, `라피 ${name}`);
  const created = await manager.register({
    guildId: guildId!,
    name,
    kind: "discord_outbound",
    secret: url,
  });
  await store.upsertManagedDiscordResource({
    guildId: guildId!,
    resourceType: "webhook",
    key: name,
    discordId: parseDiscordWebhookUrl(url).id,
    layoutDigest: "community-bootstrap-v1",
  });
  if (name === "operations-alerts-output")
    await updateEnvironment({
      OPERATIONS_DISCORD_WEBHOOK_CIPHERTEXT: encryptSecret(
        url,
        config.WEBHOOK_ENCRYPTION_KEY!,
      ),
    });
  return created.id;
}

async function githubHook(
  pat: string,
  endpoint: string,
  secret: string,
): Promise<void> {
  if (!pat) return;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${pat}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "rapi-agent-community-bootstrap",
  };
  const existingResponse = await fetch(
    "https://api.github.com/repos/justn-hyeok/rapi-agent/hooks?per_page=100",
    { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) },
  );
  if (!existingResponse.ok)
    throw new Error(`GitHub PAT 확인 실패: HTTP ${existingResponse.status}`);
  const existing = (await existingResponse.json()) as Array<{
    id: number;
    config?: { url?: string };
  }>;
  const same = existing.find((hook) => hook.config?.url === endpoint);
  const body = JSON.stringify({
    name: "web",
    active: true,
    events: ["push", "issues", "pull_request", "release"],
    config: { url: endpoint, content_type: "json", secret, insecure_ssl: "0" },
  });
  const response = await fetch(
    same
      ? `https://api.github.com/repos/justn-hyeok/rapi-agent/hooks/${same.id}`
      : "https://api.github.com/repos/justn-hyeok/rapi-agent/hooks",
    {
      method: same ? "PATCH" : "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  await response.arrayBuffer();
  if (!response.ok)
    throw new Error(`GitHub 웹훅 등록 실패: HTTP ${response.status}`);
}

try {
  for (const feed of officialFeeds)
    await store.createSource("rss", feed, "public");

  const githubOutbound = await ensureOutbound(
    "github-feed-output",
    "github_feed",
  );
  await ensureOutbound(config.TECHNICAL_RSS_WEBHOOK_NAME, "technical_rss");
  const operationsOutbound = await ensureOutbound(
    "operations-alerts-output",
    "operations_alerts",
  );

  let github = await store.webhookConnectionByName(
    guildId,
    "github-rapi-agent",
  );
  let githubSecret: string | undefined;
  let githubEndpoint: string | undefined;
  if (!github) {
    const created = await manager.register({
      guildId,
      name: "github-rapi-agent",
      kind: "github_inbound",
      destinationKind: "discord_webhook",
      destinationId: githubOutbound,
      eventFilters: ["ping", "push", "issues", "pull_request", "release"],
    });
    github = await store.getWebhookConnection(created.id);
    githubSecret = created.secret;
    githubEndpoint = created.endpoint;
  } else {
    const stored = await store.getWebhookConnection(github.id, true);
    githubSecret = decryptSecret(
      stored!.secretCiphertext!,
      config.WEBHOOK_ENCRYPTION_KEY,
    );
    githubEndpoint = `${config.RAPI_PUBLIC_BASE_URL}/webhooks/v1/${github.id}`;
  }

  let generic = await store.webhookConnectionByName(guildId, "generic-inbound");
  let genericCredentials: { endpoint?: string; secret?: string } = {};
  if (!generic) {
    const created = await manager.register({
      guildId,
      name: "generic-inbound",
      kind: "generic_inbound",
      destinationKind: "discord_webhook",
      destinationId: operationsOutbound,
      eventFilters: [],
    });
    await manager.setState(guildId, created.id, "disabled");
    generic = await store.getWebhookConnection(created.id);
    genericCredentials = created;
  }

  const pat = await stdin();
  if (pat) {
    await githubHook(pat, githubEndpoint!, githubSecret!);
  }
  await updateEnvironment({
    COMMUNITY_GUILD_ID: guildId,
    POLL_INTERVAL_SECONDS: "900",
    DISCORD_GUILD_MEMBERS_ARE_USERS: "false",
    DISCORD_USER_ROLE_IDS: await store
      .managedDiscordResourceId(guildId, "role", "rapi_user")
      .then(
        (id) => id ?? Promise.reject(new Error("라피 USER 역할이 없습니다.")),
      ),
    DISCORD_ADMIN_ROLE_IDS: await store
      .managedDiscordResourceId(guildId, "role", "rapi_staff")
      .then(
        (id) => id ?? Promise.reject(new Error("라피 운영진 역할이 없습니다.")),
      ),
    RAPI_ADMIN_CHANNEL_ID: await layout.channelId(guildId, "rapi_admin"),
    OPERATIONS_CHANNEL_ID: await layout.channelId(guildId, "operations_alerts"),
  });
  process.stdout.write(
    [
      "커뮤니티 통합 구성을 저장했습니다.",
      `GitHub 연결 ID: ${github!.id}`,
      `범용 연결 ID: ${generic!.id} (중지됨)`,
      ...(genericCredentials.endpoint
        ? [
            `범용 수신 URL: ${genericCredentials.endpoint}`,
            `범용 비밀값(이번 한 번만 표시): ${genericCredentials.secret}`,
          ]
        : []),
    ].join("\n") + "\n",
  );
} finally {
  await store.close();
}
