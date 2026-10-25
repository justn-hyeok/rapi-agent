import { createHmac, randomBytes } from "node:crypto";

/** Period-pass billing (no auto-renewal). Everything here is pure; the flag lives in config. */

export const BILLING_ORDER_STATUSES = [
  "pending",
  "paid",
  "failed",
  "canceled",
  "expired",
] as const;
export type BillingOrderStatus = (typeof BILLING_ORDER_STATUSES)[number];

/** A pending order older than this can no longer be paid and is shown as expired. */
export const BILLING_ORDER_TTL_MINUTES = 60;

export interface BillingPlan {
  id: string;
  name: string;
  description: string;
  priceKrw: number;
  periodDays: number;
  features: string[];
}

export interface BillingEntitlement {
  planId: string;
  validUntil: Date;
  /** Resolved from the plan file at read time; the table does not store features. */
  features: readonly string[];
}

const DAY_MS = 86_400_000;

/** A plan with price 0 is a placeholder: listed as "준비 중" and never sold. */
export function planPurchasable(plan: BillingPlan): boolean {
  return plan.priceKrw > 0;
}

/**
 * Feature gate. With billing off every check passes, so deploying the billing
 * code changes nothing. With billing on, only a live entitlement whose plan
 * lists the feature passes.
 */
export function allowsFeature(
  entitlement: BillingEntitlement | undefined,
  feature: string,
  billingEnabled: boolean,
  now: Date = new Date(),
): boolean {
  if (!billingEnabled) return true;
  return (
    entitlement !== undefined &&
    entitlement.validUntil.getTime() > now.getTime() &&
    entitlement.features.includes(feature)
  );
}

/** Buying again extends from `max(now, validUntil)`, never from a past date. */
export function extendEntitlement(
  validUntil: Date | undefined,
  periodDays: number,
  now: Date,
): Date {
  const base = Math.max(now.getTime(), validUntil?.getTime() ?? 0);
  return new Date(base + periodDays * DAY_MS);
}

/**
 * A refund takes back the period that order bought. Returns null when nothing
 * is left (the entitlement row is removed).
 */
export function shortenEntitlement(
  validUntil: Date,
  periodDays: number,
  now: Date,
): Date | null {
  const next = new Date(validUntil.getTime() - periodDays * DAY_MS);
  return next.getTime() > now.getTime() ? next : null;
}

/** Server-generated, 6-64 chars of `[A-Za-z0-9_-]` as Toss requires. */
export function newBillingOrderId(now: Date = new Date()): string {
  return `rapi_${now.getTime().toString(36)}_${randomBytes(12).toString("base64url")}`;
}

export function isBillingOrderId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(value);
}

/** Toss `customerKey`: opaque per user, so the Discord id never reaches the widget. */
export function billingCustomerKey(secret: string, userId: string): string {
  const key = createHmac("sha256", secret)
    .update("rapi-billing-customer-v1")
    .digest();
  return `rc_${createHmac("sha256", key).update(userId).digest("base64url").slice(0, 32)}`;
}

/** Stable per order, so a repeated confirm or cancel is the same operation at Toss. */
export function billingIdempotencyKey(
  action: "confirm" | "cancel",
  orderId: string,
): string {
  return `rapi-${action}-${orderId}`;
}

export function formatKrw(amount: number): string {
  return `${new Intl.NumberFormat("ko-KR").format(amount)}원`;
}

/** KST calendar date, `YYYY-MM-DD`, for "까지" labels. */
export function formatBillingDate(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(
    date,
  );
}
