import {
  extendEntitlement,
  shortenEntitlement,
  type BillingOrderStatus,
} from "@rapi/core";
import type { PostgresStore } from "./postgres-store.js";

export interface BillingOrder {
  orderId: string;
  userId: string;
  planId: string;
  amountKrw: number;
  status: BillingOrderStatus;
  paymentKey: string | null;
  method: string | null;
  createdAt: Date;
  paidAt: Date | null;
  canceledAt: Date | null;
  cancelReason: string | null;
  rawStatus: string | null;
}

export interface BillingEntitlementRow {
  userId: string;
  planId: string;
  validUntil: Date;
  lastOrderId: string | null;
}

interface OrderRow {
  order_id: string;
  user_id: string;
  plan_id: string;
  amount_krw: number;
  status: BillingOrderStatus;
  payment_key: string | null;
  method: string | null;
  created_at: Date;
  paid_at: Date | null;
  canceled_at: Date | null;
  cancel_reason: string | null;
  raw_status: string | null;
}

const COLUMNS =
  "order_id,user_id,plan_id,amount_krw,status,payment_key,method,created_at,paid_at,canceled_at,cancel_reason,raw_status";

function order(row: OrderRow): BillingOrder {
  return {
    orderId: row.order_id,
    userId: row.user_id,
    planId: row.plan_id,
    amountKrw: row.amount_krw,
    status: row.status,
    paymentKey: row.payment_key,
    method: row.method,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    canceledAt: row.canceled_at,
    cancelReason: row.cancel_reason,
    rawStatus: row.raw_status,
  };
}

/** What the billing service needs from storage; tests provide an in-memory fake. */
export interface BillingStorePort {
  createOrder(input: {
    orderId: string;
    userId: string;
    planId: string;
    amountKrw: number;
    now: Date;
  }): Promise<BillingOrder>;
  getOrder(orderId: string): Promise<BillingOrder | null>;
  getOrderByPaymentKey(paymentKey: string): Promise<BillingOrder | null>;
  recentOrders(limit: number): Promise<BillingOrder[]>;
  /** pending → failed. Returns false when the order was not pending. */
  markFailed(orderId: string, rawStatus: string): Promise<boolean>;
  /** pending → expired for orders older than `before`. */
  expirePending(before: Date): Promise<number>;
  /**
   * pending → paid and extends the entitlement from max(now, valid_until) in
   * one transaction. Returns the new valid_until, or null when the order was
   * not pending (nothing changes).
   */
  markPaid(input: {
    orderId: string;
    paymentKey: string;
    method: string | null;
    rawStatus: string;
    periodDays: number;
    now: Date;
  }): Promise<Date | null>;
  /**
   * paid → canceled and takes the order's period back from the entitlement
   * (removed when nothing is left). Returns false when the order was not paid.
   */
  markCanceled(input: {
    orderId: string;
    reason: string;
    rawStatus: string;
    periodDays: number;
    now: Date;
  }): Promise<boolean>;
  entitlement(userId: string): Promise<BillingEntitlementRow | null>;
}

/** Billing orders (kept as transaction records) and period entitlements. */
export class BillingStore implements BillingStorePort {
  constructor(private readonly db: PostgresStore) {}

  async createOrder(input: {
    orderId: string;
    userId: string;
    planId: string;
    amountKrw: number;
    now: Date;
  }): Promise<BillingOrder> {
    const result = await this.db.pool.query<OrderRow>(
      `INSERT INTO billing_orders(order_id,user_id,plan_id,amount_krw,created_at)
       VALUES($1,$2,$3,$4,$5) RETURNING ${COLUMNS}`,
      [input.orderId, input.userId, input.planId, input.amountKrw, input.now],
    );
    return order(result.rows[0]!);
  }

  async getOrder(orderId: string): Promise<BillingOrder | null> {
    const result = await this.db.pool.query<OrderRow>(
      `SELECT ${COLUMNS} FROM billing_orders WHERE order_id=$1`,
      [orderId],
    );
    return result.rows[0] ? order(result.rows[0]) : null;
  }

  async getOrderByPaymentKey(paymentKey: string): Promise<BillingOrder | null> {
    const result = await this.db.pool.query<OrderRow>(
      `SELECT ${COLUMNS} FROM billing_orders WHERE payment_key=$1`,
      [paymentKey],
    );
    return result.rows[0] ? order(result.rows[0]) : null;
  }

  async recentOrders(limit: number): Promise<BillingOrder[]> {
    const result = await this.db.pool.query<OrderRow>(
      `SELECT ${COLUMNS} FROM billing_orders ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(order);
  }

  async markFailed(orderId: string, rawStatus: string): Promise<boolean> {
    const result = await this.db.pool.query(
      "UPDATE billing_orders SET status='failed',raw_status=$2 WHERE order_id=$1 AND status='pending'",
      [orderId, rawStatus.slice(0, 200)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async expirePending(before: Date): Promise<number> {
    const result = await this.db.pool.query(
      "UPDATE billing_orders SET status='expired' WHERE status='pending' AND created_at<$1",
      [before],
    );
    return result.rowCount ?? 0;
  }

  async markPaid(input: {
    orderId: string;
    paymentKey: string;
    method: string | null;
    rawStatus: string;
    periodDays: number;
    now: Date;
  }): Promise<Date | null> {
    return this.db.transaction(async (client) => {
      const updated = await client.query<{ user_id: string; plan_id: string }>(
        `UPDATE billing_orders SET status='paid',payment_key=$2,method=$3,raw_status=$4,paid_at=$5
         WHERE order_id=$1 AND status IN ('pending','expired') RETURNING user_id,plan_id`,
        [
          input.orderId,
          input.paymentKey,
          input.method,
          input.rawStatus.slice(0, 200),
          input.now,
        ],
      );
      const row = updated.rows[0];
      if (!row) return null;
      const current = await client.query<{ valid_until: Date }>(
        "SELECT valid_until FROM billing_entitlements WHERE user_id=$1 FOR UPDATE",
        [row.user_id],
      );
      const validUntil = extendEntitlement(
        current.rows[0]?.valid_until,
        input.periodDays,
        input.now,
      );
      await client.query(
        `INSERT INTO billing_entitlements(user_id,plan_id,valid_until,last_order_id)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (user_id) DO UPDATE SET plan_id=$2,valid_until=$3,last_order_id=$4`,
        [row.user_id, row.plan_id, validUntil, input.orderId],
      );
      return validUntil;
    });
  }

  async markCanceled(input: {
    orderId: string;
    reason: string;
    rawStatus: string;
    periodDays: number;
    now: Date;
  }): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const updated = await client.query<{ user_id: string }>(
        `UPDATE billing_orders SET status='canceled',canceled_at=$2,cancel_reason=$3,raw_status=$4
         WHERE order_id=$1 AND status='paid' RETURNING user_id`,
        [
          input.orderId,
          input.now,
          input.reason.slice(0, 200),
          input.rawStatus.slice(0, 200),
        ],
      );
      const row = updated.rows[0];
      if (!row) return false;
      const current = await client.query<{ valid_until: Date }>(
        "SELECT valid_until FROM billing_entitlements WHERE user_id=$1 FOR UPDATE",
        [row.user_id],
      );
      if (!current.rows[0]) return true;
      const next = shortenEntitlement(
        current.rows[0].valid_until,
        input.periodDays,
        input.now,
      );
      if (next)
        await client.query(
          "UPDATE billing_entitlements SET valid_until=$2 WHERE user_id=$1",
          [row.user_id, next],
        );
      else
        await client.query(
          "DELETE FROM billing_entitlements WHERE user_id=$1",
          [row.user_id],
        );
      return true;
    });
  }

  async entitlement(userId: string): Promise<BillingEntitlementRow | null> {
    const result = await this.db.pool.query<{
      user_id: string;
      plan_id: string;
      valid_until: Date;
      last_order_id: string | null;
    }>(
      "SELECT user_id,plan_id,valid_until,last_order_id FROM billing_entitlements WHERE user_id=$1",
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          userId: row.user_id,
          planId: row.plan_id,
          validUntil: row.valid_until,
          lastOrderId: row.last_order_id,
        }
      : null;
  }
}
