import assert from "node:assert/strict";
import test from "node:test";
import { deliveryReadiness } from "../workers/runtime/src/delivery-readiness.js";

test("delivery readiness preserves disabled, failed, idle, and delivered outcomes", () => {
  assert.deepEqual(deliveryReadiness(false), {
    status: "disabled",
    outcome: "disabled",
    reason: "delivery is disabled",
  });
  assert.deepEqual(deliveryReadiness(true, "delivery failed", "delivered"), {
    status: "failed",
    outcome: "failed",
    reason: "delivery failed",
  });
  assert.deepEqual(deliveryReadiness(true, undefined, "idle"), {
    status: "ok",
    outcome: "idle",
  });
  assert.deepEqual(deliveryReadiness(true), {
    status: "ok",
    outcome: "delivered",
  });
});
