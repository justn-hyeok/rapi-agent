import {
  assertDiscordLevel,
  assertDiscordScope,
  GUILD_NOT_ALLOWED_MESSAGE,
  isGuildAllowed,
  resolveDiscordAccess,
  splitDiscordMessage,
  type DiscordAccessLevel,
  type DiscordAccessScope,
  type DiscordAllowlists,
  type DiscordIdentity,
  type SubscriptionInput,
} from "@rapi/core";
import { RapiAgent } from "./rapi-agent.js";

export const slashCommands = [
  "brief",
  "search",
  "subscribe",
  "unsubscribe",
  "sources",
  "deliveries",
  "status",
  "webhook",
  "usage",
  "usage_policy",
  "server_config",
  "chat_enable",
  "chat_disable",
  "cancel",
  "privacy",
  "schedule",
] as const;

/**
 * Slash commands that moved to the web (docs/product-direction.md, "slash 명령
 * 정리"). With the web on they answer with a link to the page instead.
 */
export const DISCORD_WEB_PAGES: Partial<
  Record<(typeof slashCommands)[number], string>
> = {
  subscribe: "/admin/subscribe",
  unsubscribe: "/admin/unsubscribe",
  sources: "/admin/sources",
  deliveries: "/admin/deliveries",
  status: "/admin/status",
  usage: "/admin/usage",
  usage_policy: "/admin/usage-policy",
  server_config: "/admin/server-config",
  webhook: "/admin/webhooks",
};

export interface DiscordCommand {
  name: (typeof slashCommands)[number];
  options: Record<string, unknown>;
}

export interface DiscordCommandResult {
  messages: string[];
  data?: Record<string, unknown>;
}

export function requiredCommandAccess(
  command: DiscordCommand["name"],
): DiscordAccessLevel {
  if (["cancel", "webhook", "server_config"].includes(command))
    return "superadmin";
  if (
    [
      "chat_enable",
      "chat_disable",
      "status",
      "sources",
      "deliveries",
      "usage_policy",
      "subscribe",
      "unsubscribe",
    ].includes(command)
  )
    return "admin";
  return "user";
}

const guildScopedCommands: ReadonlySet<DiscordCommand["name"]> = new Set([
  "usage_policy",
  "server_config",
  "chat_enable",
  "chat_disable",
]);

/** Slash names a guild-scoped admin can use in their own server. */
const GUILD_ADMIN_COMMAND_LABELS = [
  "/사용정책",
  "/서버구성",
  "/대화채널",
  "/대화해제",
];

/** Whether a command only changes the guild it runs in, or reaches all of Rapi. */
export function commandScope(
  command: DiscordCommand["name"],
): DiscordAccessScope {
  return guildScopedCommands.has(command) ? "guild" : "global";
}

function requiredString(
  options: Record<string, unknown>,
  name: string,
): string {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Missing command option: ${name}`);
  return value;
}

function optionalString(
  options: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function commaSeparated(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

export class DiscordCommandService {
  constructor(
    private readonly agent: RapiAgent,
    private readonly allowlists: DiscordAllowlists,
    private readonly operations?: {
      status: () => Promise<string>;
      privacy?: (
        identity: DiscordIdentity,
        options: Record<string, unknown>,
        level: DiscordAccessLevel,
      ) => Promise<DiscordCommandResult>;
      usage?: {
        status(
          guildId: string,
          userId: string,
          tier: "user" | "staff",
        ): Promise<string>;
        policy(guildId: string): Promise<string>;
        update(
          guildId: string,
          actorId: string,
          input: {
            userDailyLimit?: number;
            userCooldownSeconds?: number;
            globalDailyLimit?: number;
            globalConcurrency?: number;
          },
        ): Promise<string>;
      };
      serverConfig?: {
        preview(
          guildId: string,
          actorId: string,
        ): Promise<{ summary: string; planId: string }>;
        apply(
          guildId: string,
          actorId: string,
          planId: string,
        ): Promise<string>;
        export(guildId: string, format: "yaml" | "json"): Promise<string>;
      };
      /** Public web origin when WEB_ENABLED; moved commands then point to it. */
      webBaseUrl?: string;
      /** Guilds the bot answers in; undefined means no restriction. */
      guildAllowlist?: () => Promise<readonly string[] | undefined>;
      publicBrief?: (
        guildId: string,
        userId: string,
        requestId: string,
        tier: "user" | "staff",
      ) => Promise<string>;
      webhooks?: {
        register(input: {
          guildId: string;
          name: string;
          kind: "github_inbound" | "generic_inbound" | "discord_outbound";
          destinationKind?: "discord_channel" | "discord_webhook";
          destinationId?: string;
          eventFilters?: string[];
          secret?: string;
        }): Promise<{ id: string; endpoint?: string; secret?: string }>;
        list(guildId: string): Promise<
          Array<{
            id: string;
            name: string;
            kind: string;
            state: string;
          }>
        >;
        detail(guildId: string, id: string): Promise<object>;
        test(guildId: string, id: string): Promise<void>;
        setState(
          guildId: string,
          id: string,
          state: "active" | "disabled",
        ): Promise<boolean>;
      };
    },
  ) {}

  async execute(
    identity: DiscordIdentity,
    command: DiscordCommand,
  ): Promise<DiscordCommandResult> {
    if (identity.guildId && this.operations?.guildAllowlist) {
      if (
        !isGuildAllowed(
          identity.guildId,
          await this.operations.guildAllowlist(),
        )
      )
        throw new Error(GUILD_NOT_ALLOWED_MESSAGE);
    }
    const access = resolveDiscordAccess(identity, this.allowlists);
    const level = access.level;
    // A guild-scoped admin may run guild settings but nothing that reaches all of Rapi.
    const guildAdmin =
      access.scope === "guild" && commandScope(command.name) === "guild";
    let required = requiredCommandAccess(command.name);
    if (required !== "user" && commandScope(command.name) === "global")
      assertDiscordScope(access, "global", GUILD_ADMIN_COMMAND_LABELS);
    if (guildAdmin && required === "superadmin") required = "admin";
    assertDiscordLevel(level, required);
    const ownerId = identity.userId;
    const webPage = DISCORD_WEB_PAGES[command.name];
    // A button from a preview made before the web was on may still apply it.
    if (this.operations?.webBaseUrl && webPage && !command.options.viaButton)
      return {
        messages: [
          `이 기능은 웹으로 옮겼어요. ${this.operations.webBaseUrl.replace(/\/+$/, "")}${webPage} 에서 이어서 해 주세요. (Discord 계정으로 로그인)`,
        ],
        data: { webNotice: true },
      };
    switch (command.name) {
      // Frozen: /일정 gets no new behavior (docs/product-direction.md).
      case "schedule": {
        if (command.options.action === "목록") {
          const events = await this.agent.upcomingEvents(ownerId, 30);
          return {
            messages: splitDiscordMessage(
              events.length
                ? events
                    .map(
                      (event, index) =>
                        `${index + 1}. ${event.when} · ${event.title}${event.daysUntil >= 0 && event.daysUntil <= 7 ? ` (D-${event.daysUntil})` : ""}`,
                    )
                    .join("\n")
                : "앞으로 30일 안의 일정과 마감이 없습니다.",
            ),
          };
        }
        if (command.options.action === "삭제") {
          const events = await this.agent.upcomingEvents(ownerId, 30);
          const index = Number(command.options.number) - 1;
          const target = events[index];
          if (!target)
            throw new Error(
              "목록에서 그 번호를 찾지 못했습니다. /일정 목록으로 번호를 확인해 주세요.",
            );
          const result = await this.agent.scheduleCommand(ownerId, {
            action: "delete",
            id: target.id,
          });
          return {
            messages: [
              result.ok
                ? `지웠습니다: ${target.when} · ${target.title}`
                : result.message,
            ],
          };
        }
        const result = await this.agent.scheduleCommand(ownerId, {
          action: "add",
          text: command.options.content,
        });
        if (!result.ok) throw new Error(result.message);
        return { messages: [result.message] };
      }
      case "privacy": {
        if (!this.operations?.privacy)
          throw new Error("개인정보 정리 기능이 연결되지 않았습니다.");
        if (
          command.options.action === "요청" &&
          (command.options.kind ?? "user") !== "user"
        )
          assertDiscordLevel(level, "superadmin");
        return this.operations.privacy(identity, command.options, level);
      }
      case "subscribe": {
        const supplied = command.options.subscription as
          | SubscriptionInput
          | undefined;
        const cadenceInput = optionalString(command.options, "cadence");
        const cadence =
          cadenceInput === "즉시"
            ? "immediate"
            : cadenceInput === "매주"
              ? "weekly"
              : "daily";
        const input: SubscriptionInput = supplied ?? {
          ownerId,
          name: requiredString(command.options, "name"),
          sourceIds: await this.agent.store.activeSourceIds(),
          categories: commaSeparated(
            optionalString(command.options, "categories"),
          ),
          includeKeywords: commaSeparated(
            optionalString(command.options, "keywords"),
          ),
          excludeKeywords: [],
          cadence,
          timezone: "Asia/Seoul",
          channels: [{ channel: "discord_dm", recipientId: ownerId }],
          maxItems: 20,
        };
        if (input.ownerId !== ownerId)
          throw new Error("Subscription owner must match the Discord user");
        const subscriptionId = await this.agent.createSubscription(input);
        return {
          messages: [`구독을 저장했습니다: ${input.name}`],
          data: { subscriptionId },
        };
      }
      case "unsubscribe": {
        const removed = await this.agent.store.deactivateSubscription(
          ownerId,
          requiredString(command.options, "name"),
        );
        return {
          messages: [
            removed ? "구독을 해제했습니다." : "활성 구독을 찾지 못했습니다.",
          ],
        };
      }
      case "brief": {
        if (identity.guildId && this.operations?.publicBrief) {
          return {
            messages: splitDiscordMessage(
              await this.operations.publicBrief(
                identity.guildId,
                ownerId,
                optionalString(command.options, "requestId") ??
                  `brief:${identity.guildId}:${ownerId}:${Date.now()}`,
                level === "user" ? "user" : "staff",
              ),
            ),
          };
        }
        const subscriptionId =
          optionalString(command.options, "subscriptionId") ??
          (await this.agent.store.latestActiveSubscription(ownerId));
        if (!subscriptionId) throw new Error("활성 구독이 없습니다.");
        const end = optionalString(command.options, "periodEnd")
          ? new Date(requiredString(command.options, "periodEnd"))
          : new Date();
        const start = optionalString(command.options, "periodStart")
          ? new Date(requiredString(command.options, "periodStart"))
          : new Date(end.getTime() - 24 * 60 * 60_000);
        const batch = await this.agent.freezeBatch(subscriptionId, start, end);
        const state = await this.agent.deliverBatch(batch.id);
        const message = `브리핑 ${batch.id}: ${batch.items.length}개 항목, ${state}`;
        return {
          messages: splitDiscordMessage(message),
          data: { batchId: batch.id, state },
        };
      }
      case "search": {
        const rows = await this.agent.store.searchPublic(
          requiredString(command.options, "query"),
        );
        const text =
          rows.map((row) => `${row.title}\n${row.url}`).join("\n\n") ||
          "검색 결과가 없습니다.";
        const webBase = this.operations?.webBaseUrl?.replace(/\/+$/, "");
        return {
          messages: splitDiscordMessage(
            webBase
              ? `${text}\n\n웹에서 지난 소식 보기: ${webBase}/archive`
              : text,
          ),
        };
      }
      case "sources": {
        const rows = await this.agent.store.sourceStatus();
        return { messages: splitDiscordMessage(JSON.stringify(rows, null, 2)) };
      }
      case "deliveries": {
        const rows = await this.agent.store.deliveryStatus();
        return { messages: splitDiscordMessage(JSON.stringify(rows, null, 2)) };
      }
      case "status": {
        if (!this.operations)
          throw new Error("운영 상태 기능이 설정되지 않았습니다.");
        return {
          messages: splitDiscordMessage(await this.operations.status()),
        };
      }
      case "usage": {
        if (!identity.guildId || !this.operations?.usage)
          throw new Error("사용량 기능이 설정되지 않았습니다.");
        return {
          messages: splitDiscordMessage(
            await this.operations.usage.status(
              identity.guildId,
              ownerId,
              level === "user" ? "user" : "staff",
            ),
          ),
        };
      }
      case "usage_policy": {
        if (!identity.guildId || !this.operations?.usage)
          throw new Error("사용 정책 기능이 설정되지 않았습니다.");
        const action = optionalString(command.options, "action") ?? "조회";
        if (action === "조회")
          return {
            messages: splitDiscordMessage(
              await this.operations.usage.policy(identity.guildId),
            ),
          };
        assertDiscordLevel(level, guildAdmin ? "admin" : "superadmin");
        const number = (name: string): number | undefined => {
          const value = command.options[name];
          if (value === undefined || value === null || value === "")
            return undefined;
          const parsed = Number(value);
          if (!Number.isInteger(parsed))
            throw new Error(`${name}은 정수여야 합니다.`);
          return parsed;
        };
        const userDailyLimit = number("userDailyLimit");
        const userCooldownSeconds = number("userCooldownSeconds");
        const globalDailyLimit = number("globalDailyLimit");
        const globalConcurrency = number("globalConcurrency");
        if (userDailyLimit !== undefined && userDailyLimit < 1)
          throw new Error("사용자 일일 한도는 1 이상이어야 합니다.");
        if (userCooldownSeconds !== undefined && userCooldownSeconds < 0)
          throw new Error("쿨다운은 0 이상이어야 합니다.");
        if (globalDailyLimit !== undefined && globalDailyLimit < 1)
          throw new Error("전체 일일 한도는 1 이상이어야 합니다.");
        if (
          globalConcurrency !== undefined &&
          (globalConcurrency < 1 || globalConcurrency > 8)
        )
          throw new Error("동시 실행 수는 1~8이어야 합니다.");
        const update: {
          userDailyLimit?: number;
          userCooldownSeconds?: number;
          globalDailyLimit?: number;
          globalConcurrency?: number;
        } = {};
        if (userDailyLimit !== undefined)
          update.userDailyLimit = userDailyLimit;
        if (userCooldownSeconds !== undefined)
          update.userCooldownSeconds = userCooldownSeconds;
        if (globalDailyLimit !== undefined)
          update.globalDailyLimit = globalDailyLimit;
        if (globalConcurrency !== undefined)
          update.globalConcurrency = globalConcurrency;
        return {
          messages: splitDiscordMessage(
            await this.operations.usage.update(
              identity.guildId,
              ownerId,
              update,
            ),
          ),
        };
      }
      case "server_config": {
        if (!identity.guildId || !this.operations?.serverConfig)
          throw new Error("서버 구성 기능이 설정되지 않았습니다.");
        const action = optionalString(command.options, "action") ?? "미리보기";
        if (action === "미리보기") {
          const preview = await this.operations.serverConfig.preview(
            identity.guildId,
            ownerId,
          );
          return {
            messages: splitDiscordMessage(preview.summary),
            data: {
              confirmationCustomId: `server_config_apply:${preview.planId}`,
            },
          };
        }
        if (action === "적용")
          return {
            messages: splitDiscordMessage(
              await this.operations.serverConfig.apply(
                identity.guildId,
                ownerId,
                requiredString(command.options, "planId"),
              ),
            ),
          };
        if (action === "내보내기") {
          const format =
            optionalString(command.options, "format") === "json"
              ? "json"
              : "yaml";
          return {
            messages: splitDiscordMessage(
              await this.operations.serverConfig.export(
                identity.guildId,
                format,
              ),
            ),
          };
        }
        throw new Error("지원하지 않는 서버 구성 동작입니다.");
      }
      case "webhook": {
        if (!this.operations?.webhooks)
          throw new Error("웹훅 관리 기능이 설정되지 않았습니다.");
        if (!identity.guildId) throw new Error("서버 채널에서 실행하세요.");
        const action = requiredString(command.options, "action");
        if (action === "등록") {
          const rawKind = requiredString(command.options, "kind");
          const kind =
            rawKind === "GitHub 수신"
              ? "github_inbound"
              : rawKind === "범용 수신"
                ? "generic_inbound"
                : rawKind === "Discord 발송"
                  ? "discord_outbound"
                  : undefined;
          if (!kind) throw new Error("지원하지 않는 웹훅 종류입니다.");
          const destinationType = optionalString(
            command.options,
            "destinationKind",
          );
          const destinationKind =
            destinationType === "채널"
              ? "discord_channel"
              : destinationType === "웹훅"
                ? "discord_webhook"
                : undefined;
          const created = await this.operations.webhooks.register({
            guildId: identity.guildId,
            name: requiredString(command.options, "name"),
            kind,
            ...(destinationKind ? { destinationKind } : {}),
            ...(optionalString(command.options, "destinationId")
              ? {
                  destinationId: optionalString(
                    command.options,
                    "destinationId",
                  )!,
                }
              : {}),
            eventFilters: commaSeparated(
              optionalString(command.options, "events"),
            ),
            ...(optionalString(command.options, "secret")
              ? { secret: optionalString(command.options, "secret")! }
              : {}),
          });
          const credentials = created.endpoint
            ? `\n수신 URL: ${created.endpoint}\n비밀값(지금 한 번만 표시): ${created.secret}`
            : "";
          return {
            messages: [`웹훅 연결을 등록했습니다: ${created.id}${credentials}`],
            data: { id: created.id },
          };
        }
        if (action === "목록") {
          const connections = await this.operations.webhooks.list(
            identity.guildId,
          );
          return {
            messages: splitDiscordMessage(
              connections.length
                ? connections
                    .map(
                      (item) =>
                        `${item.id} · ${item.name} · ${item.kind} · ${item.state}`,
                    )
                    .join("\n")
                : "등록된 웹훅이 없습니다.",
            ),
          };
        }
        const id = requiredString(command.options, "id");
        if (action === "상세") {
          const item = await this.operations.webhooks.detail(
            identity.guildId,
            id,
          );
          return {
            messages: splitDiscordMessage(JSON.stringify(item, null, 2)),
          };
        }
        if (action === "테스트") {
          await this.operations.webhooks.test(identity.guildId, id);
          return { messages: ["웹훅 테스트를 접수했습니다."] };
        }
        if (action === "중지" || action === "재개") {
          const changed = await this.operations.webhooks.setState(
            identity.guildId,
            id,
            action === "중지" ? "disabled" : "active",
          );
          return {
            messages: [
              changed
                ? `웹훅을 ${action}했습니다.`
                : "변경할 웹훅을 찾지 못했습니다.",
            ],
          };
        }
        throw new Error("지원하지 않는 웹훅 동작입니다.");
      }
      case "chat_enable": {
        if (!identity.guildId || !identity.channelId)
          throw new Error("서버 채널에서 실행하세요.");
        await this.agent.store.enableChatChannel(
          identity.guildId,
          identity.channelId,
          ownerId,
        );
        return {
          messages: [
            "이 채널에서 ChatOps를 시작합니다. `라피야!` 뒤에 질문을 적어주세요.",
          ],
        };
      }
      case "chat_disable": {
        if (!identity.channelId) throw new Error("서버 채널에서 실행하세요.");
        const disabled = await this.agent.store.disableChatChannel(
          identity.channelId,
        );
        return {
          messages: [
            disabled
              ? "이 채널의 ChatOps를 껐습니다."
              : "이 채널에서는 ChatOps가 켜져 있지 않습니다.",
          ],
        };
      }
      case "cancel": {
        const taskId =
          optionalString(command.options, "taskId") ??
          (await this.agent.store.latestCancellableTask(ownerId));
        if (!taskId) {
          // A running ChatOps run belongs to the chat process, which polls this flag.
          const chatRun = await this.agent.store.requestChatOpsCancel(ownerId);
          if (chatRun)
            return {
              messages: [
                `실행 중인 ChatOps 작업 ${chatRun}의 중단을 요청했어요. 몇 초 안에 멈추고 채널에 결과가 올라와요.`,
              ],
            };
          throw new Error(
            "취소할 작업이 없습니다. 접수만 되고 아직 실행 전인 요청은 채널에서 ‘라피야! 멈춰’로 중단하세요.",
          );
        }
        await this.agent.cancelTask(taskId);
        return { messages: ["작업 중단과 취소 상태를 확인했습니다."] };
      }
    }
  }
}
