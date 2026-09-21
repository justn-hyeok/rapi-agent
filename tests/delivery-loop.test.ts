import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireHealthyDeliveryResults } from "../workers/runtime/src/delivery-loop.js";

describe("requireHealthyDeliveryResults", () => {
  it("allows idle and fully delivered loops", () => {
    assert.doesNotThrow(() => requireHealthyDeliveryResults([]));
    assert.doesNotThrow(() =>
      requireHealthyDeliveryResults(["delivered", "delivered"]),
    );
  });

  it("rejects a loop with a failed batch", () => {
    assert.throws(
      () => requireHealthyDeliveryResults(["delivered", "partially_failed"]),
      /failed batch results/,
    );
  });
});
