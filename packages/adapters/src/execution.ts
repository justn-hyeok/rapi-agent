import type { OmpAdapter, OmpDispatchResult } from "@rapi/core";

export class OmpHttpAdapter implements OmpAdapter {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
  ) {}

  async cancel(receiptId: string, attemptId: string): Promise<boolean> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        receipt_id: receiptId,
        execution_attempt_id: attemptId,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json()) as {
      cancelled?: boolean;
      reason?: string;
    };
    if (!response.ok)
      throw new Error(payload.reason ?? `OMP returned ${response.status}`);
    return payload.cancelled === true;
  }

  async dispatch(
    specification: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<OmpDispatchResult> {
    const response = await fetch(
      `${this.endpoint.replace(/\/$/, "")}/dispatch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(specification),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const payload = (await response.json()) as {
      receipt_id?: string;
      accepted?: boolean;
      reason?: string;
    };
    if (!response.ok || !payload.receipt_id)
      throw new Error(payload.reason ?? `OMP returned ${response.status}`);
    return {
      receiptId: payload.receipt_id,
      accepted: payload.accepted ?? true,
      ...(payload.reason ? { reason: payload.reason } : {}),
    };
  }
}
