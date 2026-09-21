export type DeliveryResultStatus = "healthy" | "idle" | "failed";

export type DeliveryAssessment = {
  status: DeliveryResultStatus;
};

export function assessDeliveryResults(
  states: readonly string[],
): DeliveryAssessment {
  if (states.length === 0) return { status: "idle" };
  if (states.every((state) => state === "delivered")) {
    return { status: "healthy" };
  }
  return { status: "failed" };
}
