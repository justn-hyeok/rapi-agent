import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DiscordWebhookClient,
  DiscordWebhookError,
  decryptSecret,
  encryptSecret,
  normalizeGitHubWebhook,
  verifyWebhookSignature,
  type ExternalItem,
} from "@rapi/adapters";
import {
  canonicalizeUrl,
  classify,
  contentFingerprint,
  summarize,
  splitDiscordMessage,
  type NormalizedItem,
} from "@rapi/core";
import {
  PostgresStore,
  type WebhookConnection,
  type WebhookConnectionKind,
  type WebhookQueueJob,
} from "@rapi/db";

export interface ManagedWebhookOptions {
  encryptionKey: string;
  publicBaseUrl: string;
  discordClient?: DiscordWebhookClient;
  verifyChannel?: (guildId: string, channelId: string) => Promise<boolean>;
  publicReady?: () => Promise<boolean>;
}

export class WebhookManager {
  private readonly discord: DiscordWebhookClient;
  private readonly publicBaseUrl: string;

  constructor(
    private readonly store: PostgresStore,
    private readonly options: ManagedWebhookOptions,
  ) {
    this.discord = options.discordClient ?? new DiscordWebhookClient();
    const base = new URL(options.publicBaseUrl);
    if (
      base.protocol !== "https:" ||
      base.hostname.endsWith(".trycloudflare.com")
    )
      throw new Error(
        "Managed inbound webhooks require a fixed HTTPS public URL",
      );
    this.publicBaseUrl = base.toString().replace(/\/$/, "");
  }

  async register(input: {
    guildId: string;
    name: string;
    kind: WebhookConnectionKind;
    destinationKind?: "discord_channel" | "discord_webhook";
    destinationId?: string;
    eventFilters?: string[];
    secret?: string;
  }): Promise<{ id: string; endpoint?: string; secret?: string }> {
    if (!input.name.trim() || input.name.length > 100)
      throw new Error("Webhook name must be between 1 and 100 characters");
    const filters = input.eventFilters ?? [];
    if (
      filters.length > 20 ||
      filters.some((event) => !/^[A-Za-z0-9._-]{1,64}$/.test(event))
    )
      throw new Error("Webhook event filters are invalid");
    if (
      input.kind === "github_inbound" &&
      filters.some(
        (event) =>
          !["ping", "push", "issues", "pull_request", "release"].includes(
            event,
          ),
      )
    )
      throw new Error("Unsupported GitHub webhook event filter");
    if (
      input.kind !== "discord_outbound" &&
      this.options.publicReady &&
      !(await this.options.publicReady())
    )
      throw new Error(
        "고정 공개 주소의 접근 확인이 끝나기 전에는 수신 웹훅을 활성화할 수 없습니다.",
      );
    if (input.kind === "discord_outbound") {
      if (!input.secret) throw new Error("Discord webhook URL is required");
      const identity = await this.discord.inspect(input.secret);
      if (identity.guildId !== input.guildId)
        throw new Error("Discord webhook is not in this server");
    } else {
      if (!input.destinationKind || !input.destinationId)
        throw new Error("Inbound webhook destination is required");
      if (input.destinationKind === "discord_webhook") {
        const destination = await this.store.getWebhookConnection(
          input.destinationId,
        );
        if (
          !destination ||
          destination.guildId !== input.guildId ||
          destination.kind !== "discord_outbound"
        )
          throw new Error("Discord webhook destination is not in this server");
      } else if (
        !this.options.verifyChannel ||
        !(await this.options.verifyChannel(input.guildId, input.destinationId))
      ) {
        throw new Error("Discord channel destination is not in this server");
      }
    }
    const secret =
      input.kind === "discord_outbound"
        ? input.secret!
        : (input.secret ?? randomBytes(32).toString("hex"));
    const connection = await this.store.createWebhookConnection({
      guildId: input.guildId,
      name: input.name,
      kind: input.kind,
      ...(input.destinationKind
        ? { destinationKind: input.destinationKind }
        : {}),
      ...(input.destinationId ? { destinationId: input.destinationId } : {}),
      eventFilters: filters,
      secretCiphertext: encryptSecret(secret, this.options.encryptionKey),
    });
    return {
      id: connection.id,
      ...(input.kind === "discord_outbound"
        ? {}
        : {
            endpoint: `${this.publicBaseUrl}/webhooks/v1/${connection.id}`,
            secret,
          }),
    };
  }

  list(guildId: string): Promise<WebhookConnection[]> {
    return this.store.listWebhookConnections(guildId);
  }

  async detail(guildId: string, id: string): Promise<WebhookConnection> {
    const connection = await this.store.getWebhookConnection(id);
    if (!connection || connection.guildId !== guildId)
      throw new Error("Webhook connection not found");
    return connection;
  }

  setState(
    guildId: string,
    id: string,
    state: "active" | "disabled",
  ): Promise<boolean> {
    return this.store.setWebhookConnectionState(guildId, id, state);
  }

  async receive(
    connectionId: string,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    now = new Date(),
  ): Promise<{ inserted: boolean; itemId?: string }> {
    const connection = await this.store.getWebhookConnection(
      connectionId,
      true,
    );
    if (
      !connection ||
      connection.state !== "active" ||
      !connection.secretCiphertext
    )
      throw new Error("Webhook connection is not active");
    if (connection.kind === "discord_outbound")
      throw new Error("Outbound connection cannot receive events");
    const secret = decryptSecret(
      connection.secretCiphertext,
      this.options.encryptionKey,
    );
    const isGitHub = connection.kind === "github_inbound";
    const signature = header(
      headers,
      isGitHub ? "x-hub-signature-256" : "x-rapi-signature",
    );
    if (!signature || !verifyWebhookSignature(rawBody, signature, secret))
      throw new WebhookAuthenticationError();
    const eventType = header(
      headers,
      isGitHub ? "x-github-event" : "x-rapi-event",
    );
    const deliveryId = header(
      headers,
      isGitHub ? "x-github-delivery" : "x-rapi-delivery",
    );
    if (!eventType || !deliveryId)
      throw new Error("Webhook event and delivery ID are required");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(eventType) || deliveryId.length > 200)
      throw new Error("Webhook event or delivery ID is invalid");
    const payload = parseObject(rawBody);
    const external = isGitHub
      ? normalizeGitHubWebhook(eventType, payload)
      : parseExternalItem(payload, deliveryId);
    if (!connection.sourceId)
      throw new Error("Inbound connection has no source");
    const normalized = normalize(connection.sourceId, external, now, isGitHub);
    return this.store.ingestManagedWebhook({
      connectionId,
      deliveryId,
      eventType,
      payloadHash: createHash("sha256").update(rawBody).digest("hex"),
      rawPayload: payload,
      item: normalized,
      summary: summarize(normalized),
    });
  }

  async test(guildId: string, id: string): Promise<void> {
    const connection = await this.detail(guildId, id);
    if (connection.kind === "discord_outbound") {
      const secretConnection = await this.store.getWebhookConnection(id, true);
      await this.discord.send(
        decryptSecret(
          secretConnection!.secretCiphertext!,
          this.options.encryptionKey,
        ),
        "[라피 웹훅 테스트] 연결이 정상입니다.",
      );
      return;
    }
    const event: ExternalItem = {
      externalId: `test-${randomUUID()}`,
      url: `${this.publicBaseUrl}/health`,
      title: "라피 웹훅 수신 테스트",
      body: "내부 수신·저장·발송 대기열을 확인하는 합성 이벤트입니다.",
      author: "rapi",
      publishedAt: new Date().toISOString(),
      metadata: { eventType: "test", synthetic: true },
    };
    const normalized = normalize(
      connection.sourceId!,
      event,
      new Date(),
      false,
    );
    const eventType = connection.eventFilters[0] ?? "test";
    await this.store.ingestManagedWebhook({
      connectionId: id,
      deliveryId: event.externalId,
      eventType,
      payloadHash: createHash("sha256").update(event.externalId).digest("hex"),
      rawPayload: event as unknown as Record<string, unknown>,
      item: normalized,
      summary: summarize(normalized),
    });
  }
}

export class WebhookAuthenticationError extends Error {
  constructor() {
    super("Invalid webhook signature");
  }
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseObject(body: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Webhook body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function parseExternalItem(
  payload: Record<string, unknown>,
  deliveryId: string,
): ExternalItem {
  for (const field of ["url", "title", "body"] as const)
    if (typeof payload[field] !== "string" || !payload[field])
      throw new Error(`Generic webhook requires ${field}`);
  return {
    externalId:
      typeof payload.externalId === "string" && payload.externalId
        ? payload.externalId
        : deliveryId,
    url: payload.url as string,
    title: payload.title as string,
    body: payload.body as string,
    author: typeof payload.author === "string" ? payload.author : null,
    publishedAt:
      typeof payload.publishedAt === "string" ? payload.publishedAt : null,
    metadata:
      payload.metadata && typeof payload.metadata === "object"
        ? (payload.metadata as Record<string, unknown>)
        : {},
  };
}

function normalize(
  sourceId: string,
  external: ExternalItem,
  now: Date,
  github: boolean,
): NormalizedItem {
  return {
    id: randomUUID(),
    rawEventId: randomUUID(),
    sourceId,
    normalizerVersion: github ? "github-webhook-v1" : "generic-webhook-v1",
    canonicalUrl: canonicalizeUrl(external.url),
    title: external.title.trim(),
    body: external.body.trim(),
    author: external.author,
    publishedAt: external.publishedAt ? new Date(external.publishedAt) : null,
    collectedAt: now,
    visibility: "private",
    contentFingerprint: contentFingerprint(external.title, external.body),
    metadata: external.metadata,
    categories: classify(external.title, external.body),
  };
}

export class WebhookDeliveryWorker {
  constructor(
    private readonly store: PostgresStore,
    private readonly encryptionKey: string,
    private readonly sendChannel: (
      channelId: string,
      content: string,
    ) => Promise<void>,
    private readonly discord = new DiscordWebhookClient(),
  ) {}

  async runOnce(limit = 10): Promise<number> {
    const jobs = await this.store.leaseWebhookJobs(limit, 30_000);
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  private async process(job: WebhookQueueJob): Promise<void> {
    const payload = job.payload;
    const content = `${String(payload.title)}\n${String(payload.summary)}\n${String(payload.url)}`;
    try {
      if (typeof payload.sourceConnectionId === "string") {
        const source = await this.store.getWebhookConnection(
          payload.sourceConnectionId,
        );
        if (source?.state !== "active") {
          await this.store.releaseWebhookJob(job.id, 30_000);
          return;
        }
      }
      if (payload.destinationKind === "discord_channel") {
        const chunks = splitDiscordMessage(content);
        for (
          let index = Number(payload.sentChunks ?? 0);
          index < chunks.length;
          index += 1
        ) {
          await this.sendChannel(String(payload.destinationId), chunks[index]!);
          await this.store.updateWebhookJobProgress(job.id, index + 1);
        }
      } else if (payload.destinationKind === "discord_webhook") {
        const destination = await this.store.getWebhookConnection(
          String(payload.destinationId),
          true,
        );
        if (!destination || destination.kind !== "discord_outbound")
          throw new DiscordWebhookError(
            "Discord webhook destination is missing",
            false,
            0,
          );
        if (destination.state !== "active") {
          await this.store.releaseWebhookJob(job.id, 30_000);
          return;
        }
        await this.discord.send(
          decryptSecret(destination.secretCiphertext!, this.encryptionKey),
          content,
          Number(payload.sentChunks ?? 0),
          (count) => this.store.updateWebhookJobProgress(job.id, count),
          job.attempts,
        );
      } else {
        throw new DiscordWebhookError("Unknown webhook destination", false, 0);
      }
      await this.store.completeWebhookJob(job.id);
    } catch (error) {
      const webhookError =
        error instanceof DiscordWebhookError
          ? error
          : new DiscordWebhookError(
              error instanceof Error
                ? error.message
                : "Webhook delivery failed",
              true,
              Math.min(60_000, 1000 * 2 ** job.attempts),
            );
      await this.store.failWebhookJob(
        job.id,
        webhookError.message,
        webhookError.delayMs,
        webhookError.retryable,
      );
    }
  }
}
