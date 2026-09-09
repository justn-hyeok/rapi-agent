import { createPublicKey, verify } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  DiscordCommandService,
  RapiAgent,
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

export const discordCommandAliases = {
  브리핑: "brief",
  검색: "search",
  구독: "subscribe",
  구독해제: "unsubscribe",
  수집원: "sources",
  발송내역: "deliveries",
  대화채널: "chat_enable",
  대화해제: "chat_disable",
  작업: "task",
  승인: "approve",
  취소: "cancel",
} as const satisfies Record<string, DiscordCommand["name"]>;

export const slashCommandDefinitions = [
  {
    name: "브리핑",
    description: "최근 24시간 브리핑을 만들어 보냅니다",
    type: 1,
  },
  {
    name: "검색",
    description: "수집한 항목을 검색합니다",
    type: 1,
    options: [stringOption("검색어", "찾을 내용을 입력하세요")],
  },
  {
    name: "구독",
    description: "Discord 알림 구독을 만듭니다",
    type: 1,
    options: [
      stringOption("이름", "구독 이름"),
      stringOption("키워드", "쉼표로 구분한 포함 키워드", false),
      stringOption("분야", "쉼표로 구분한 분야", false),
      stringOption("주기", "즉시, 매일, 매주 중 하나", false),
    ],
  },
  {
    name: "구독해제",
    description: "알림 구독을 해제합니다",
    type: 1,
    options: [stringOption("이름", "해제할 구독 이름")],
  },
  { name: "수집원", description: "수집원 상태를 확인합니다", type: 1 },
  { name: "발송내역", description: "최근 발송 상태를 확인합니다", type: 1 },
  {
    name: "대화채널",
    description: "현재 채널에서 라피 ChatOps를 켭니다",
    type: 1,
  },
  {
    name: "대화해제",
    description: "현재 채널의 라피 ChatOps를 끕니다",
    type: 1,
  },
  {
    name: "작업",
    description: "OMP 개발 작업을 준비합니다",
    type: 1,
    options: [
      stringOption("내용", "할 일을 한글로 입력하세요"),
      stringOption("공급자", "codex, cursor, commandcode (고트)", false),
      stringOption("모델", "스파크, 아스트라 또는 정확한 모델 ID", false),
    ],
  },
  {
    name: "승인",
    description: "가장 최근 작업을 승인하고 실행합니다",
    type: 1,
  },
  {
    name: "취소",
    description: "가장 최근 진행 중인 작업을 취소합니다",
    type: 1,
  },
] satisfies Array<{
  name: string;
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
  integrations?: {
    webhook?: { agent: RapiAgent; secret: string };
    omp?: { agent: RapiAgent; secret: string };
  },
) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health")
        return json(response, 200, { status: "ok" });
      if (request.method !== "POST")
        return json(response, 404, { error: "not found" });
      const body = await readBody(request);
      if (request.url === "/omp/callback" && integrations?.omp) {
        const signature = request.headers["x-omp-signature"];
        if (typeof signature !== "string")
          return json(response, 401, { error: "missing OMP signature" });
        const applied = await integrations.omp.agent.receiveOmpCallback(
          body,
          signature,
          integrations.omp.secret,
        );
        return json(response, 202, { applied });
      }
      if (request.url?.startsWith("/webhooks/") && integrations?.webhook) {
        const signature = request.headers["x-rapi-signature"];
        if (
          typeof signature !== "string" ||
          !verifyWebhookSignature(body, signature, integrations.webhook.secret)
        ) {
          return json(response, 401, { error: "invalid webhook signature" });
        }
        const sourceId = decodeURIComponent(
          request.url.slice("/webhooks/".length),
        );
        const payload = JSON.parse(body.toString("utf8")) as ExternalItem;
        const result = await integrations.webhook.agent.ingestExternalItem(
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
        member?: { user?: { id?: string }; roles?: string[] };
        user?: { id?: string };
        guild_id?: string;
        channel_id?: string;
        data?: {
          name?: string;
          options?: Array<{ name: string; value: unknown }>;
        };
      };
      if (interaction.type === 1) return json(response, 200, { type: 1 });
      const userId = interaction.member?.user?.id ?? interaction.user?.id;
      if (!userId || !interaction.data?.name)
        return json(response, 400, { error: "invalid interaction" });
      const commandName = (
        discordCommandAliases as Record<
          string,
          DiscordCommand["name"] | undefined
        >
      )[interaction.data.name];
      if (!commandName)
        return json(response, 400, { error: "unknown interaction command" });
      const options = Object.fromEntries(
        (interaction.data.options ?? []).map((option) => [
          option.name,
          option.value,
        ]),
      );
      const aliases: Record<string, string> = {
        검색어: "query",
        이름: "name",
        키워드: "keywords",
        분야: "categories",
        주기: "cadence",
        내용: "content",
        모델: "model",
        공급자: "provider",
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
          ...(interaction.member?.roles
            ? { roleIds: interaction.member.roles }
            : {}),
        },
        { name: commandName, options },
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
