import {
  assertDiscordAccess,
  assertDiscordLevel,
  splitDiscordMessage,
  type DiscordAccessLevel,
  type DiscordAllowlists,
  type DiscordIdentity,
  type SubscriptionInput,
} from "@rapi/core";
import { RapiAgent } from "./rapi-agent.js";
import { parseTaskSelection, resolveProviderSelection } from "@rapi/contracts";

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
  "task",
  "approve",
  "cancel",
] as const;

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
  if (
    ["task", "approve", "cancel", "webhook", "server_config"].includes(command)
  )
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
    const level = assertDiscordAccess(identity, this.allowlists);
    assertDiscordLevel(level, requiredCommandAccess(command.name));
    const ownerId = identity.userId;
    switch (command.name) {
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
        return {
          messages: splitDiscordMessage(
            rows.map((row) => `${row.title}\n${row.url}`).join("\n\n") ||
              "검색 결과가 없습니다.",
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
        assertDiscordLevel(level, "superadmin");
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
      case "task": {
        const supplied = command.options.specification as
          | Record<string, unknown>
          | undefined;
        const content = optionalString(command.options, "content");
        const requestedModel = optionalString(command.options, "model");
        const parsed = content
          ? parseTaskSelection(
              content,
              optionalString(command.options, "provider"),
              requestedModel,
            )
          : undefined;
        const specification =
          supplied ??
          (content
            ? {
                goal: parsed!.task,
                requirements: [parsed!.task],
                provider: parsed!.provider,
                model: parsed!.model,
                acceptance_criteria: [
                  "요청한 변경을 완료한다.",
                  "관련 검사를 통과한다.",
                ],
                permissions: ["repo:write", "commit:create"],
                forbidden_actions: ["push", "pull request", "deploy"],
                timeout_seconds: 1800,
              }
            : undefined);
        if (!specification) throw new Error("작업 내용을 입력하세요.");
        const selection = resolveProviderSelection(specification);
        const task = await this.agent.createTask(ownerId, specification);
        return {
          messages: [
            `작업을 준비했습니다. 실행하려면 /승인 을 입력하세요.\n작업 ID: ${task.taskId} · ${selection.provider} / ${selection.model ?? "공급자 기본 모델"}`,
          ],
          data: task,
        };
      }
      case "approve": {
        const latest = await this.agent.store.latestAwaitingTask(ownerId);
        const taskId = optionalString(command.options, "taskId") ?? latest?.id;
        if (!taskId) throw new Error("승인할 작업이 없습니다.");
        const revision = command.options.revision
          ? Number(command.options.revision)
          : (latest?.revision ?? 1);
        const permissions = Array.isArray(command.options.permissions)
          ? command.options.permissions.map(String)
          : (latest?.permissions ?? []);
        await this.agent.approveTask(
          taskId,
          revision,
          ownerId,
          permissions,
          optionalString(command.options, "messageRef") ?? "discord-command",
        );
        const dispatch = await this.agent.dispatchTask(taskId);
        return {
          messages: [
            `작업을 승인하고 OMP에 전달했습니다: ${dispatch.receiptId} · ${dispatch.provider} / ${dispatch.model ?? "공급자 기본 모델"}`,
          ],
          data: dispatch,
        };
      }
      case "cancel": {
        const taskId =
          optionalString(command.options, "taskId") ??
          (await this.agent.store.latestCancellableTask(ownerId));
        if (!taskId) throw new Error("취소할 작업이 없습니다.");
        await this.agent.store.cancelTask(taskId);
        return { messages: ["작업을 취소했습니다."] };
      }
    }
  }
}
