import { createPublicKey, verify } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  DiscordCommandService,
  RapiAgent,
  slashCommands,
  type DiscordCommand,
} from "@rapi/agent";
import { verifyWebhookSignature, type ExternalItem } from "@rapi/adapters";

const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

export function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: Buffer,
): boolean {
  const key = createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
  return verify(
    null,
    Buffer.concat([Buffer.from(timestamp), body]),
    key,
    Buffer.from(signatureHex, "hex"),
  );
}

const stringOption = (name: string, description: string, required = true) => ({
  type: 3,
  name,
  description,
  required,
});

export const slashCommandDefinitions = [
  {
    name: "brief",
    description: "Create and deliver a briefing",
    type: 1,
    options: [
      stringOption("subscription_id", "Subscription ID"),
      stringOption("period_start", "ISO period start"),
      stringOption("period_end", "ISO period end"),
    ],
  },
  {
    name: "search",
    description: "Search collected items",
    type: 1,
    options: [stringOption("query", "Search query")],
  },
  {
    name: "subscribe",
    description: "Create or update a subscription",
    type: 1,
    options: [stringOption("subscription", "Subscription JSON")],
  },
  {
    name: "unsubscribe",
    description: "Disable a subscription",
    type: 1,
    options: [stringOption("name", "Subscription name")],
  },
  { name: "sources", description: "Show source health", type: 1 },
  { name: "deliveries", description: "Show delivery status", type: 1 },
  {
    name: "task",
    description: "Create a development task",
    type: 1,
    options: [stringOption("specification", "Task specification JSON")],
  },
  {
    name: "approve",
    description: "Approve and dispatch a task revision",
    type: 1,
    options: [
      stringOption("task_id", "Task ID"),
      {
        type: 4,
        name: "revision",
        description: "Task revision",
        required: true,
      },
      stringOption("permissions", "Approved permission JSON array"),
      stringOption("message_ref", "Approval message reference"),
    ],
  },
  {
    name: "cancel",
    description: "Cancel a task",
    type: 1,
    options: [stringOption("task_id", "Task ID")],
  },
] satisfies Array<{
  name: (typeof slashCommands)[number];
  description: string;
  type: number;
  options?: Array<Record<string, unknown>>;
}>;

export async function registerSlashCommands(
  applicationId: string,
  botToken: string,
  guildId?: string,
): Promise<void> {
  const scope = guildId
    ? `/applications/${applicationId}/guilds/${guildId}/commands`
    : `/applications/${applicationId}/commands`;
  const response = await fetch(`https://discord.com/api/v10${scope}`, {
    method: "PUT",
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(slashCommandDefinitions),
  });
  if (!response.ok)
    throw new Error(`Discord command registration failed: ${response.status}`);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new Error("Discord interaction exceeds 1 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createDiscordInteractionServer(
  service: DiscordCommandService,
  publicKey: string,
  webhook?: { agent: RapiAgent; secret: string },
) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health")
        return json(response, 200, { status: "ok" });
      if (request.method !== "POST")
        return json(response, 404, { error: "not found" });
      const body = await readBody(request);
      if (request.url?.startsWith("/webhooks/") && webhook) {
        const signature = request.headers["x-rapi-signature"];
        if (
          typeof signature !== "string" ||
          !verifyWebhookSignature(body, signature, webhook.secret)
        ) {
          return json(response, 401, { error: "invalid webhook signature" });
        }
        const sourceId = decodeURIComponent(
          request.url.slice("/webhooks/".length),
        );
        const payload = JSON.parse(body.toString("utf8")) as ExternalItem;
        const result = await webhook.agent.ingestExternalItem(
          sourceId,
          payload,
        );
        return json(response, 202, result);
      }
      if (request.url !== "/interactions")
        return json(response, 404, { error: "not found" });
      const signature = request.headers["x-signature-ed25519"];
      const timestamp = request.headers["x-signature-timestamp"];
      if (
        typeof signature !== "string" ||
        typeof timestamp !== "string" ||
        !verifyDiscordRequest(publicKey, signature, timestamp, body)
      ) {
        return json(response, 401, { error: "invalid signature" });
      }
      const interaction = JSON.parse(body.toString("utf8")) as {
        type: number;
        member?: { user?: { id?: string } };
        user?: { id?: string };
        guild_id?: string;
        channel_id?: string;
        data?: {
          name?: DiscordCommand["name"];
          options?: Array<{ name: string; value: unknown }>;
        };
      };
      if (interaction.type === 1) return json(response, 200, { type: 1 });
      const userId = interaction.member?.user?.id ?? interaction.user?.id;
      if (!userId || !interaction.data?.name)
        return json(response, 400, { error: "invalid interaction" });
      const options = Object.fromEntries(
        (interaction.data.options ?? []).map((option) => [
          option.name,
          option.value,
        ]),
      );
      const aliases: Record<string, string> = {
        subscription_id: "subscriptionId",
        period_start: "periodStart",
        period_end: "periodEnd",
        task_id: "taskId",
        message_ref: "messageRef",
      };
      for (const [discordName, internalName] of Object.entries(aliases)) {
        if (options[discordName] !== undefined) {
          options[internalName] = options[discordName];
        }
      }
      for (const key of ["subscription", "specification", "permissions"]) {
        if (typeof options[key] === "string")
          options[key] = JSON.parse(options[key] as string) as unknown;
      }
      const result = await service.execute(
        {
          userId,
          ...(interaction.guild_id ? { guildId: interaction.guild_id } : {}),
          ...(interaction.channel_id
            ? { channelId: interaction.channel_id }
            : {}),
        },
        { name: interaction.data.name, options },
      );
      return json(response, 200, {
        type: 4,
        data: { content: result.messages[0] ?? "완료", flags: 64 },
      });
    } catch (error) {
      return json(response, 400, {
        error: error instanceof Error ? error.message : "request failed",
      });
    }
  });
}
