export type DeliveryOutcome = "delivered" | "idle";

export function deliveryReadiness(
  enabled: boolean,
  lastError?: string,
  outcome?: DeliveryOutcome,
): {
  status: "ok" | "failed" | "disabled";
  outcome: DeliveryOutcome | "failed" | "disabled";
  reason?: string;
} {
  if (!enabled)
    return {
      status: "disabled",
      outcome: "disabled",
      reason: "delivery is disabled",
    };
  if (lastError)
    return { status: "failed", outcome: "failed", reason: lastError };
  return { status: "ok", outcome: outcome ?? "delivered" };
}
