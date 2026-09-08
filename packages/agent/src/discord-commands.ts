import {
  assertDiscordAccess,
  splitDiscordMessage,
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
        const input = command.options.subscription as
          | SubscriptionInput
          | undefined;
        if (!input || input.ownerId !== ownerId)
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
        const subscriptionId = requiredString(
          command.options,
          "subscriptionId",
        );
        const start = new Date(requiredString(command.options, "periodStart"));
        const end = new Date(requiredString(command.options, "periodEnd"));
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
      case "task": {
        const specification = command.options.specification as
          | Record<string, unknown>
          | undefined;
        if (!specification) throw new Error("Missing task specification");
        const task = await this.agent.createTask(ownerId, specification);
        return {
          messages: [
            `작업 ${task.taskId} revision ${task.revision} 승인이 필요합니다.`,
          ],
          data: task,
        };
      }
      case "approve": {
        const taskId = requiredString(command.options, "taskId");
        const revision = Number(command.options.revision);
        const permissions = Array.isArray(command.options.permissions)
          ? command.options.permissions.map(String)
          : [];
        await this.agent.approveTask(
          taskId,
          revision,
          ownerId,
          permissions,
          requiredString(command.options, "messageRef"),
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
        await this.agent.store.cancelTask(
          requiredString(command.options, "taskId"),
        );
        return { messages: ["작업을 취소했습니다."] };
      }
    }
  }
}
