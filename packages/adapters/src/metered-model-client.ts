import {
  budgetMonth,
  evaluateBudget,
  formatUsd,
  type BudgetAlertLevel,
  type DeliveryAdapter,
  type DeliveryPayload,
} from "@rapi/core";
import {
  ModelBudgetExceededError,
  PUBLIC_MODEL_FEATURES,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "./model-client.js";

export interface ModelUsageEntry {
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  ok: boolean;
  error?: string | undefined;
  latencyMs: number;
  note?: string | undefined;
}

/** What `MeteredModelClient` needs from storage (`ModelUsageStore` in @rapi/db). */
export interface ModelUsageLedger {
  record(entry: ModelUsageEntry): Promise<void>;
  spendMicroUsd(from: Date, to: Date): Promise<number>;
  claimBudgetAlert(month: string, level: BudgetAlertLevel): Promise<boolean>;
  releaseBudgetAlert(month: string, level: BudgetAlertLevel): Promise<void>;
}

/** Sends a message to every SUPERADMIN; false when nobody could be reached. */
export interface ModelBudgetNotifier {
  notifySuperadmins(text: string, key: string): Promise<boolean>;
}

export function superadminDmNotifier(
  delivery: DeliveryAdapter,
  superadminIds: readonly string[],
): ModelBudgetNotifier {
  return {
    async notifySuperadmins(text, key) {
      let delivered = false;
      for (const recipientId of superadminIds) {
        const payload: DeliveryPayload = {
          subject: "모델 비용 알림",
          text,
          html: "",
          itemIds: [],
          discord: { embeds: [], content: text, flags: 4, components: [] },
        };
        try {
          await delivery.send(
            { channel: "discord_dm", recipientId },
            payload,
            `${key}:${recipientId}`,
          );
          delivered = true;
        } catch {
          // Try the next owner; the alert is released if nobody was reached.
        }
      }
      return delivered;
    },
  };
}

export interface MeteredOptions {
  /** Monthly cap in micro-USD; undefined = metering only. */
  budgetMicroUsd?: number | undefined;
  notifier?: ModelBudgetNotifier | undefined;
  /** Model id to record when a call fails before a response names one. */
  modelFor?: ((feature: ModelRequest["feature"]) => string) | undefined;
  now?: () => Date;
  onWarning?: (message: string) => void;
}

const alertText = (
  level: BudgetAlertLevel,
  spent: number,
  budget: number,
): string =>
  level === "warn"
    ? `모델 비용이 이번 달 상한의 80%에 도달했습니다 (${formatUsd(spent)} / ${formatUsd(budget)}). 100%가 되면 공개 기능이 멈추고 운영자 기능만 계속됩니다.`
    : `모델 비용이 이번 달 상한을 넘었습니다 (${formatUsd(spent)} / ${formatUsd(budget)}). 공개 기능(아카이브 Q&A, 공개 Q&A, 챗봇, 재작성)을 멈췄고 운영자 기능은 계속됩니다. 한도는 MODEL_MONTHLY_BUDGET_USD로 조정합니다.`;

/** Records every call and enforces the monthly cap on public features. */
export class MeteredModelClient implements ModelClient {
  private readonly warnedModels = new Set<string>();

  constructor(
    private readonly inner: ModelClient,
    private readonly ledger: ModelUsageLedger,
    private readonly options: MeteredOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private warn(message: string): void {
    this.options.onWarning?.(message);
  }

  /** Cap check; alerts once per month and level, never fails a call by itself. */
  private async check(
    feature: ModelRequest["feature"],
    onlyAlert: boolean,
  ): Promise<void> {
    const budget = this.options.budgetMicroUsd;
    if (!budget) return;
    const month = budgetMonth(this.now());
    let spent: number;
    try {
      spent = await this.ledger.spendMicroUsd(month.startsAt, month.endsAt);
    } catch (error) {
      // Fail open: a broken ledger must not take the whole feature down.
      this.warn(`model budget check failed: ${String(error)}`);
      return;
    }
    const decision = evaluateBudget({
      spentMicroUsd: spent,
      budgetMicroUsd: budget,
      publicFeature: PUBLIC_MODEL_FEATURES.has(feature),
    });
    if (decision.alert) await this.alert(month.key, decision.alert, spent);
    if (!onlyAlert && decision.blocked)
      throw new ModelBudgetExceededError(feature);
  }

  private async alert(
    month: string,
    level: BudgetAlertLevel,
    spent: number,
  ): Promise<void> {
    const notifier = this.options.notifier;
    if (!notifier) return;
    try {
      if (!(await this.ledger.claimBudgetAlert(month, level))) return;
      const sent = await notifier.notifySuperadmins(
        alertText(level, spent, this.options.budgetMicroUsd!),
        `model-budget:${month}:${level}`,
      );
      if (!sent) await this.ledger.releaseBudgetAlert(month, level);
    } catch (error) {
      this.warn(`model budget alert failed: ${String(error)}`);
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    await this.check(request.feature, false);
    const started = Date.now();
    let response: ModelResponse;
    try {
      response = await this.inner.complete(request);
    } catch (error) {
      await this.record({
        feature: request.feature,
        model: this.options.modelFor?.(request.feature) ?? "unknown",
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
      });
      throw error;
    }
    const unknownPrice = response.usage.costSource === "unknown";
    if (unknownPrice && !this.warnedModels.has(response.model)) {
      this.warnedModels.add(response.model);
      this.warn(`no price for model ${response.model}; cost recorded as 0`);
    }
    await this.record({
      feature: request.feature,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costMicroUsd: response.usage.costMicroUsd,
      ok: true,
      latencyMs: Date.now() - started,
      ...(unknownPrice ? { note: "unknown_price" } : {}),
    });
    await this.check(request.feature, true);
    return response;
  }

  private async record(entry: ModelUsageEntry): Promise<void> {
    try {
      await this.ledger.record(entry);
    } catch (error) {
      this.warn(`model usage was not recorded: ${String(error)}`);
    }
  }
}
