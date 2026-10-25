import {
  BILLING_ORDER_TTL_MINUTES,
  billingCustomerKey,
  newBillingOrderId,
  planPurchasable,
  type BillingEntitlement,
  type BillingPlan,
} from "@rapi/core";
import {
  TossApiError,
  TossUncertainError,
  type TossClient,
  type TossPayment,
} from "@rapi/adapters";
import type { BillingOrder, BillingStorePort } from "@rapi/db";

export type CheckoutResult =
  | { kind: "ok"; order: BillingOrder; plan: BillingPlan }
  | { kind: "unknown_plan" }
  | { kind: "not_purchasable"; plan: BillingPlan };

export type CompleteResult =
  | { kind: "paid"; order: BillingOrder; validUntil: Date | null }
  | { kind: "not_found" }
  /** The order is no longer pending (failed, canceled, expired, or paid under another key). */
  | { kind: "closed"; order: BillingOrder }
  | { kind: "tampered" }
  | { kind: "failed"; message: string }
  /** Toss did not answer or the payment is not DONE yet; the webhook reconciles it. */
  | { kind: "waiting"; order: BillingOrder };

export type BillingWebhookResult = "ignored" | "applied";

export type RefundResult =
  | { kind: "refunded"; order: BillingOrder }
  | { kind: "not_found" }
  | { kind: "not_paid"; order: BillingOrder }
  | { kind: "failed"; message: string };

export interface BillingServiceOptions {
  store: BillingStorePort;
  toss: TossClient;
  plans: BillingPlan[];
  /** Secret the opaque Toss customerKey is derived from. */
  secret: string;
  now?: () => Date;
}

/**
 * Orders, confirmation, reconciliation and refunds. The amount of an order
 * always comes from the plan file; query strings and webhook bodies are hints
 * that are checked against the stored order and Toss's own answer.
 */
export class BillingService {
  private readonly now: () => Date;

  constructor(private readonly options: BillingServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  plans(): BillingPlan[] {
    return this.options.plans;
  }

  plan(id: string): BillingPlan | undefined {
    return this.options.plans.find((plan) => plan.id === id);
  }

  customerKey(userId: string): string {
    return billingCustomerKey(this.options.secret, userId);
  }

  /** The user's live entitlement with features resolved from the plan file. */
  async entitlement(userId: string): Promise<BillingEntitlement | undefined> {
    const row = await this.options.store.entitlement(userId);
    if (!row || row.validUntil.getTime() <= this.now().getTime())
      return undefined;
    return {
      planId: row.planId,
      validUntil: row.validUntil,
      features: this.plan(row.planId)?.features ?? [],
    };
  }

  /** `<plan name>` for the entitlement, used by `/me`; the plan file may have dropped the id. */
  planName(planId: string): string {
    return this.plan(planId)?.name ?? planId;
  }

  async checkout(userId: string, planId: string): Promise<CheckoutResult> {
    const plan = this.plan(planId);
    if (!plan) return { kind: "unknown_plan" };
    if (!planPurchasable(plan)) return { kind: "not_purchasable", plan };
    const now = this.now();
    await this.options.store.expirePending(
      new Date(now.getTime() - BILLING_ORDER_TTL_MINUTES * 60_000),
    );
    const order = await this.options.store.createOrder({
      orderId: newBillingOrderId(now),
      userId,
      planId: plan.id,
      amountKrw: plan.priceKrw,
      now,
    });
    return { kind: "ok", order, plan };
  }

  async complete(input: {
    userId: string;
    orderId: string;
    paymentKey: string;
    amount: number;
  }): Promise<CompleteResult> {
    const { store, toss } = this.options;
    const order = await store.getOrder(input.orderId);
    if (!order || order.userId !== input.userId) return { kind: "not_found" };
    // A reload: same payment key on an already paid order is the same result, no second confirm.
    if (order.status === "paid" && order.paymentKey === input.paymentKey)
      return {
        kind: "paid",
        order,
        validUntil: (await store.entitlement(order.userId))?.validUntil ?? null,
      };
    if (order.status !== "pending") return { kind: "closed", order };
    if (input.amount !== order.amountKrw) {
      await store.markFailed(order.orderId, "amount_mismatch");
      return { kind: "tampered" };
    }
    let payment: TossPayment;
    try {
      payment = await toss.confirm({
        paymentKey: input.paymentKey,
        orderId: order.orderId,
        amount: order.amountKrw,
      });
    } catch (error) {
      if (error instanceof TossApiError) {
        await store.markFailed(order.orderId, error.code);
        return { kind: "failed", message: error.message };
      }
      if (error instanceof TossUncertainError)
        return { kind: "waiting", order };
      throw error;
    }
    if (
      payment.orderId !== order.orderId ||
      payment.totalAmount !== order.amountKrw
    ) {
      await store.markFailed(order.orderId, "payment_mismatch");
      return { kind: "tampered" };
    }
    if (payment.status !== "DONE") return { kind: "waiting", order };
    return this.settle(order, payment);
  }

  /** Marks a pending order paid from a Toss DONE payment; the loser of a race reads the winner's row. */
  private async settle(
    order: BillingOrder,
    payment: TossPayment,
  ): Promise<CompleteResult> {
    const plan = this.plan(order.planId);
    if (!plan)
      throw new Error(`plan ${order.planId} is missing from the plan file`);
    const validUntil = await this.options.store.markPaid({
      orderId: order.orderId,
      paymentKey: payment.paymentKey,
      method: payment.method,
      rawStatus: payment.status,
      periodDays: plan.periodDays,
      now: this.now(),
    });
    const current = (await this.options.store.getOrder(order.orderId)) ?? order;
    return {
      kind: "paid",
      order: current,
      validUntil:
        validUntil ??
        (await this.options.store.entitlement(order.userId))?.validUntil ??
        null,
    };
  }

  recentOrders(limit: number): Promise<BillingOrder[]> {
    return this.options.store.recentOrders(limit);
  }

  async fail(input: {
    userId: string;
    orderId: string;
    code: string;
  }): Promise<BillingOrder | null> {
    const order = await this.options.store.getOrder(input.orderId);
    if (!order || order.userId !== input.userId) return null;
    if (order.status === "pending")
      await this.options.store.markFailed(order.orderId, input.code);
    return (await this.options.store.getOrder(order.orderId)) ?? order;
  }

  /**
   * Toss general webhooks are unsigned: the body only names a payment. State
   * changes come from `getPayment`, never from the body. Throws when Toss or
   * the store fails so the caller answers 5xx and Toss retries.
   */
  async reconcile(paymentKey: string): Promise<BillingWebhookResult> {
    const { store, toss } = this.options;
    const payment = await toss.getPayment(paymentKey);
    const order = await store.getOrder(payment.orderId);
    if (!order || payment.totalAmount !== order.amountKrw) return "ignored";
    if (payment.status === "DONE") {
      if (order.status !== "pending" && order.status !== "expired")
        return "ignored";
      const result = await this.settle(order, payment);
      return result.kind === "paid" ? "applied" : "ignored";
    }
    if (payment.status === "CANCELED") {
      if (order.status !== "paid" || order.paymentKey !== payment.paymentKey)
        return "ignored";
      const plan = this.plan(order.planId);
      if (!plan) return "ignored";
      return (await store.markCanceled({
        orderId: order.orderId,
        reason: "toss_canceled",
        rawStatus: payment.status,
        periodDays: plan.periodDays,
        now: this.now(),
      }))
        ? "applied"
        : "ignored";
    }
    if (payment.status === "ABORTED" || payment.status === "EXPIRED")
      return (await store.markFailed(order.orderId, payment.status))
        ? "applied"
        : "ignored";
    return "ignored";
  }

  async refund(orderId: string, reason: string): Promise<RefundResult> {
    const { store, toss } = this.options;
    const order = await store.getOrder(orderId);
    if (!order) return { kind: "not_found" };
    if (order.status !== "paid" || !order.paymentKey)
      return { kind: "not_paid", order };
    const plan = this.plan(order.planId);
    if (!plan)
      return {
        kind: "failed",
        message: "플랜 파일에 이 주문의 플랜이 없어요.",
      };
    let rawStatus = "CANCELED";
    try {
      rawStatus = (await toss.cancel(order.paymentKey, reason)).status;
    } catch (error) {
      // Already canceled at Toss: only our own state is behind.
      if (
        !(
          error instanceof TossApiError &&
          error.code === "ALREADY_CANCELED_PAYMENT"
        )
      )
        return {
          kind: "failed",
          message:
            error instanceof TossApiError
              ? error.message
              : "토스 응답을 확인하지 못했어요. 토스 상점관리자에서 상태를 확인한 뒤 다시 시도해 주세요.",
        };
    }
    await store.markCanceled({
      orderId: order.orderId,
      reason,
      rawStatus,
      periodDays: plan.periodDays,
      now: this.now(),
    });
    return {
      kind: "refunded",
      order: (await store.getOrder(order.orderId)) ?? order,
    };
  }
}
