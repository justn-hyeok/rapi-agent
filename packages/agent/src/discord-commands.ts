import {
  assertDiscordAccess,
  splitDiscordMessage,
  type DiscordAllowlists,
  type DiscordIdentity,
  type SubscriptionInput,
} from "@rapi/core";
import { RapiAgent } from "./rapi-agent.js";
import { parseModelDirective, resolveCodexModel } from "@rapi/contracts";

export const slashCommands = [
  "brief",
  "search",
  "subscribe",
  "unsubscribe",
  "sources",
  "deliveries",
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
  ) {}

  async execute(
    identity: DiscordIdentity,
    command: DiscordCommand,
  ): Promise<DiscordCommandResult> {
    assertDiscordAccess(identity, this.allowlists);
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
        const rows = await this.agent.store.search(
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
        const parsed = content ? parseModelDirective(content) : undefined;
        const specification =
          supplied ??
          (content
            ? {
                goal: parsed!.task,
                requirements: [parsed!.task],
                model: requestedModel
                  ? resolveCodexModel(requestedModel)
                  : parsed!.model,
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
        const task = await this.agent.createTask(ownerId, specification);
        return {
          messages: [
            `작업을 준비했습니다. 실행하려면 /승인 을 입력하세요.\n작업 ID: ${task.taskId}`,
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
            `작업을 승인하고 OMP에 전달했습니다: ${dispatch.receiptId}`,
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
