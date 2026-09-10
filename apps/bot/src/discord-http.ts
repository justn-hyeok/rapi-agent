import { createPublicKey, verify } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  DiscordCommandService,
  RapiAgent,
  WebhookAuthenticationError,
  WebhookManager,
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

const integerOption = (name: string, description: string) => ({
  type: 4,
  name,
  description,
  required: false,
  min_value: 0,
});

export const discordCommandAliases = {
  브리핑: "brief",
  검색: "search",
  구독: "subscribe",
  구독해제: "unsubscribe",
  수집원: "sources",
  발송내역: "deliveries",
  상태: "status",
  사용량: "usage",
  사용정책: "usage_policy",
  서버구성: "server_config",
  웹훅: "webhook",
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
  { name: "상태", description: "라피 운영 상태를 확인합니다", type: 1 },
  {
    name: "사용량",
    description: "내 Spark 사용량과 초기화 시각을 봅니다",
    type: 1,
  },
  {
    name: "사용정책",
    description: "Spark 사용 정책을 조회하거나 변경합니다",
    type: 1,
    options: [
      { type: 1, name: "조회", description: "현재 사용 정책을 봅니다" },
      {
        type: 1,
        name: "설정",
        description: "USER 및 전체 한도를 변경합니다",
        options: [
          integerOption("사용자일일한도", "USER 1명당 하루 호출 수"),
          integerOption("쿨다운초", "USER 호출 사이의 최소 초"),
          integerOption("전체일일한도", "서버 전체 하루 호출 수"),
          integerOption("동시실행", "서버 전체 동시 실행 수"),
        ],
      },
    ],
  },
  {
    name: "서버구성",
    description: "Discord 채널 구성을 관리합니다",
    type: 1,
    options: [
      {
        type: 1,
        name: "미리보기",
        description: "변경 목록과 10분 적용 버튼을 만듭니다",
      },
      {
        type: 1,
        name: "적용",
        description: "미리보기 계획 ID를 적용합니다",
        options: [stringOption("계획", "미리보기에서 받은 계획 ID")],
      },
      {
        type: 1,
        name: "내보내기",
        description: "현재 원본 구성을 YAML 또는 JSON으로 봅니다",
        options: [stringOption("형식", "yaml 또는 json", false)],
      },
    ],
  },
  {
    name: "웹훅",
    description: "웹훅 연결을 관리합니다",
    type: 1,
    options: [
      {
        type: 1,
        name: "등록",
        description: "웹훅 연결을 등록합니다",
        options: [
          stringOption("이름", "연결 이름"),
          stringOption("종류", "GitHub 수신, 범용 수신, Discord 발송"),
          stringOption("목적지종류", "채널 또는 웹훅", false),
          stringOption("목적지", "채널 ID 또는 Discord 발송 연결 ID", false),
          stringOption("이벤트", "쉼표로 구분한 이벤트", false),
          stringOption("비밀", "발송 URL 또는 선택한 수신 비밀값", false),
        ],
      },
      { type: 1, name: "목록", description: "웹훅 연결 목록을 봅니다" },
      {
        type: 1,
        name: "상세",
        description: "웹훅 연결 상세를 봅니다",
        options: [stringOption("연결", "연결 ID")],
      },
      {
        type: 1,
        name: "테스트",
        description: "웹훅 연결을 테스트합니다",
        options: [stringOption("연결", "연결 ID")],
      },
      {
        type: 1,
        name: "중지",
        description: "웹훅 연결을 중지합니다",
        options: [stringOption("연결", "연결 ID")],
      },
      {
        type: 1,
        name: "재개",
        description: "웹훅 연결을 재개합니다",
        options: [stringOption("연결", "연결 ID")],
      },
    ],
  },
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
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`https://discord.com/api/v10${scope}`, {
      method: "PUT",
      headers: {
        authorization: `Bot ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(slashCommandDefinitions),
    });
    if (response.ok) {
      await response.arrayBuffer();
      return;
    }
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      retry_after?: number;
    };
    if (response.status === 429 && attempt < 4) {
      const delayMs = Math.min(
        30_000,
        Math.max(1000, (body.retry_after ?? 1) * 1000),
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new Error(
      `Discord command registration failed: ${response.status}${body.message ? ` ${body.message}` : ""}`,
    );
  }
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
    managedWebhook?: WebhookManager;
    omp?: { agent: RapiAgent; secret: string };
    readiness?: () => Promise<unknown>;
    component?: (
      identity: {
        userId: string;
        guildId?: string;
        channelId?: string;
        roleIds?: string[];
        guildPermissions?: string;
      },
      customId: string,
    ) => Promise<string>;
  },
) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health")
        return json(response, 200, { status: "ok" });
      if (request.method === "GET" && request.url === "/ready") {
        if (!integrations?.readiness)
          return json(response, 503, { status: "unavailable" });
        const ready = await integrations.readiness();
        const isReady =
          !!ready &&
          typeof ready === "object" &&
          "ready" in ready &&
          (ready as { ready: unknown }).ready === true;
        return json(response, isReady ? 200 : 503, ready);
      }
      if (request.method !== "POST")
        return json(response, 404, { error: "not found" });
      const body = await readBody(request);
      if (
        request.url?.startsWith("/webhooks/v1/") &&
        integrations?.managedWebhook
      ) {
        const connectionId = decodeURIComponent(
          request.url.slice("/webhooks/v1/".length),
        );
        const result = await integrations.managedWebhook.receive(
          connectionId,
          body,
          request.headers,
        );
        return json(response, 202, result);
      }
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
        id?: string;
        type: number;
        application_id?: string;
        token?: string;
        member?: {
          user?: { id?: string };
          roles?: string[];
          permissions?: string;
        };
        user?: { id?: string };
        guild_id?: string;
        channel_id?: string;
        data?: {
          name?: string;
          custom_id?: string;
          options?: Array<{ name: string; value: unknown }>;
        };
      };
      if (interaction.type === 1) return json(response, 200, { type: 1 });
      const userId = interaction.member?.user?.id ?? interaction.user?.id;
      if (!userId) return json(response, 400, { error: "invalid interaction" });
      const identity = {
        userId,
        ...(interaction.guild_id ? { guildId: interaction.guild_id } : {}),
        ...(interaction.channel_id
          ? { channelId: interaction.channel_id }
          : {}),
        ...(interaction.member?.roles
          ? { roleIds: interaction.member.roles }
          : {}),
        ...(interaction.member?.permissions
          ? { guildPermissions: interaction.member.permissions }
          : {}),
      };
      if (interaction.type === 3 && interaction.data?.custom_id) {
        if (!integrations?.component)
          return json(response, 400, { error: "component unavailable" });
        if (
          interaction.data.custom_id.startsWith("server_config_apply:") &&
          interaction.application_id &&
          interaction.token
        ) {
          json(response, 200, { type: 5, data: { flags: 64 } });
          void integrations
            .component(identity, interaction.data.custom_id)
            .then(async (message) => {
              const update = await fetch(
                `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    content: message,
                    allowed_mentions: { parse: [] },
                  }),
                },
              );
              await update.arrayBuffer();
            })
            .catch(async (error: unknown) => {
              const update = await fetch(
                `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    content:
                      error instanceof Error
                        ? error.message
                        : "서버 구성 적용 실패",
                    allowed_mentions: { parse: [] },
                  }),
                },
              );
              await update.arrayBuffer();
            });
          return;
        }
        const message = await integrations.component(
          identity,
          interaction.data.custom_id,
        );
        return json(response, 200, {
          type: 4,
          data: { content: message, flags: 64 },
        });
      }
      if (!interaction.data?.name)
        return json(response, 400, { error: "invalid interaction" });
      const commandName = (
        discordCommandAliases as Record<
          string,
          DiscordCommand["name"] | undefined
        >
      )[interaction.data.name];
      if (!commandName)
        return json(response, 400, { error: "unknown interaction command" });
      const suppliedOptions = interaction.data.options ?? [];
      const subcommand = suppliedOptions[0] as
        | {
            name?: string;
            type?: number;
            options?: Array<{ name: string; value: unknown }>;
          }
        | undefined;
      const leafOptions =
        subcommand?.type === 1 ? (subcommand.options ?? []) : suppliedOptions;
      const options = Object.fromEntries(
        leafOptions.map((option) => [option.name, option.value]),
      );
      if (subcommand?.type === 1) options.action = subcommand.name;
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
        종류: "kind",
        목적지종류: "destinationKind",
        목적지: "destinationId",
        이벤트: "events",
        비밀: "secret",
        연결: "id",
        계획: "planId",
        형식: "format",
        사용자일일한도: "userDailyLimit",
        쿨다운초: "userCooldownSeconds",
        전체일일한도: "globalDailyLimit",
        동시실행: "globalConcurrency",
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
      if (interaction.id) options.requestId = interaction.id;
      const command = { name: commandName, options };
      if (
        ((commandName === "webhook" && options.action === "테스트") ||
          commandName === "brief" ||
          (commandName === "server_config" && options.action === "적용")) &&
        interaction.application_id &&
        interaction.token
      ) {
        const isPublic = commandName === "brief";
        json(response, 200, { type: 5, data: { flags: isPublic ? 0 : 64 } });
        void service
          .execute(identity, command)
          .then(async (result) => {
            const update = await fetch(
              `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  content: result.messages[0] ?? "완료",
                  allowed_mentions: { parse: [] },
                }),
              },
            );
            await update.arrayBuffer();
          })
          .catch(async (error: unknown) => {
            const update = await fetch(
              `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  content:
                    error instanceof Error ? error.message : "요청 처리 실패",
                  allowed_mentions: { parse: [] },
                }),
              },
            );
            await update.arrayBuffer();
          });
        return;
      }
      const result = await service.execute(identity, command);
      const confirmationCustomId = result.data?.confirmationCustomId;
      const components =
        typeof confirmationCustomId === "string"
          ? [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 4,
                    label: "서버 구성 적용",
                    custom_id: confirmationCustomId,
                  },
                ],
              },
            ]
          : undefined;
      const isPublic = ["search", "brief", "usage"].includes(commandName);
      json(response, 200, {
        type: 4,
        data: {
          content: result.messages[0] ?? "완료",
          flags: isPublic ? 0 : 64,
          ...(components ? { components } : {}),
          allowed_mentions: { parse: [] },
        },
      });
      if (
        result.messages.length > 1 &&
        interaction.application_id &&
        interaction.token
      ) {
        void (async () => {
          for (const content of result.messages.slice(1)) {
            const followup = await fetch(
              `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  content,
                  ...(isPublic ? {} : { flags: 64 }),
                  allowed_mentions: { parse: [] },
                }),
              },
            );
            await followup.arrayBuffer();
          }
        })().catch(() => undefined);
      }
      return;
    } catch (error) {
      const managedWebhookRequest = request.url?.startsWith("/webhooks/v1/");
      const status =
        error instanceof WebhookAuthenticationError
          ? 401
          : error instanceof Error && /conflicting payload/.test(error.message)
            ? 409
            : 400;
      return json(response, status, {
        error: managedWebhookRequest
          ? status === 401
            ? "invalid webhook signature"
            : status === 409
              ? "conflicting webhook delivery"
              : "webhook rejected"
          : error instanceof Error
            ? error.message
            : "request failed",
      });
    }
  });
}
