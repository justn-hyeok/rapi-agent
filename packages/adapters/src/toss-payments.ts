import { billingIdempotencyKey } from "@rapi/core";

const API = "https://api.tosspayments.com";
const TIMEOUT_MS = 15_000;

/** The slice of a Toss payment object Rapi reads; everything else is ignored. */
export interface TossPayment {
  paymentKey: string;
  orderId: string;
  status: string;
  totalAmount: number;
  method: string | null;
}

/** A Toss API answer with an error body (4xx/5xx); `code` is Toss's own code. */
export class TossApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Toss ${status} ${code}: ${message}`);
    this.name = "TossApiError";
  }
}

/** The request may or may not have reached Toss; the order must be reconciled, not failed. */
export class TossUncertainError extends Error {
  constructor() {
    super("Toss request outcome unknown");
    this.name = "TossUncertainError";
  }
}

export interface TossClient {
  confirm(input: {
    paymentKey: string;
    orderId: string;
    amount: number;
  }): Promise<TossPayment>;
  getPayment(paymentKey: string): Promise<TossPayment>;
  cancel(paymentKey: string, reason: string): Promise<TossPayment>;
}

function payment(body: Record<string, unknown>): TossPayment {
  if (
    typeof body.paymentKey !== "string" ||
    typeof body.orderId !== "string" ||
    typeof body.status !== "string" ||
    typeof body.totalAmount !== "number"
  )
    throw new Error("Toss returned an unexpected payment object");
  return {
    paymentKey: body.paymentKey,
    orderId: body.orderId,
    status: body.status,
    totalAmount: body.totalAmount,
    method: typeof body.method === "string" ? body.method : null,
  };
}

/**
 * Toss Payments REST client (payment confirm, lookup, cancel). The secret key
 * only goes into the Authorization header; no error text ever contains it.
 */
export function createTossClient(options: {
  secretKey: string;
  fetch?: typeof fetch;
}): TossClient {
  const http = options.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.secretKey}:`).toString("base64")}`;

  async function call(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    idempotencyKey: string | undefined,
    retryOnNetworkError: boolean,
  ): Promise<TossPayment> {
    const attempt = async (): Promise<Response> =>
      http(`${API}${path}`, {
        method,
        headers: {
          authorization,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    let response: Response;
    try {
      response = await attempt();
    } catch {
      // Same Idempotency-Key, so a repeat cannot charge twice.
      if (!retryOnNetworkError) throw new TossUncertainError();
      try {
        response = await attempt();
      } catch {
        throw new TossUncertainError();
      }
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error pages are reported by status alone.
    }
    if (!response.ok) {
      if (response.status >= 500) throw new TossUncertainError();
      throw new TossApiError(
        response.status,
        typeof parsed.code === "string" ? parsed.code.slice(0, 80) : "UNKNOWN",
        typeof parsed.message === "string"
          ? parsed.message.slice(0, 200)
          : "request failed",
      );
    }
    return payment(parsed);
  }

  return {
    confirm: ({ paymentKey, orderId, amount }) =>
      call(
        "POST",
        "/v1/payments/confirm",
        { paymentKey, orderId, amount },
        billingIdempotencyKey("confirm", orderId),
        true,
      ),
    getPayment: (paymentKey) =>
      call(
        "GET",
        `/v1/payments/${encodeURIComponent(paymentKey)}`,
        undefined,
        undefined,
        false,
      ),
    cancel: (paymentKey, reason) =>
      call(
        "POST",
        `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`,
        { cancelReason: reason },
        billingIdempotencyKey("cancel", paymentKey),
        true,
      ),
  };
}
