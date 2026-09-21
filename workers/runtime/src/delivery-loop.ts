import { assessDeliveryResults } from "./delivery-result.js";
import type { DeliveryAssessment } from "./delivery-result.js";

export function requireHealthyDeliveryResults(
  states: readonly string[],
): DeliveryAssessment {
  const assessment = assessDeliveryResults(states);
  if (assessment.status === "failed")
    throw new Error("Scheduled delivery contains failed batch results");
  return assessment;
}
