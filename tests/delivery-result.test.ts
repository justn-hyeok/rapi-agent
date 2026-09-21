import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDeliveryResults } from "../workers/runtime/src/delivery-result.js";

describe("assessDeliveryResults", () => {
  it("reports idle when there are no states", () => {
    assert.deepEqual(assessDeliveryResults([]), { status: "idle" });
  });
  it("reports healthy for a single delivered state", () => {
    assert.deepEqual(assessDeliveryResults(["delivered"]), {
      status: "healthy",
    });
  });
  it("reports healthy when every state is delivered", () => {
    assert.deepEqual(assessDeliveryResults(["delivered", "delivered"]), {
      status: "healthy",
    });
  });
  it("reports failed for non-delivered and unknown states", () => {
    for (const state of [
      "failed",
      "partially_failed",
      "dead_letter",
      "ready",
      "unknown_state",
    ]) {
      assert.deepEqual(assessDeliveryResults([state]), { status: "failed" });
    }
  });
  it("reports failed when delivered and failed states are mixed", () => {
    assert.deepEqual(assessDeliveryResults(["delivered", "failed"]), {
      status: "failed",
    });
  });
});
