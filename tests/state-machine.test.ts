import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidStateTransitionError,
  assertDeliveryTransition,
  assertTaskTransition,
} from "../packages/core/src/index.js";

describe("delivery state contract", () => {
  it("allows retrying only after a failed delivery attempt", () => {
    assert.doesNotThrow(() =>
      assertDeliveryTransition("partially_failed", "retrying"),
    );
    assert.throws(
      () => assertDeliveryTransition("delivered", "retrying"),
      InvalidStateTransitionError,
    );
  });
  it("keeps delivered and dead-letter batches terminal", () => {
    assert.throws(() => assertDeliveryTransition("delivered", "sending"));
    assert.throws(() => assertDeliveryTransition("dead_letter", "retrying"));
  });
});

describe("task state contract", () => {
  it("requires approval before dispatch", () => {
    assert.throws(() =>
      assertTaskTransition("awaiting_approval", "dispatched"),
    );
    assert.doesNotThrow(() => assertTaskTransition("approved", "dispatched"));
  });
  it("returns changed approved specifications to approval", () => {
    assert.doesNotThrow(() =>
      assertTaskTransition("approved", "awaiting_approval"),
    );
  });
  it("keeps terminal states terminal", () => {
    for (const state of [
      "completed",
      "failed",
      "rejected",
      "expired",
      "cancelled",
    ] as const) {
      assert.throws(() => assertTaskTransition(state, "running"));
    }
  });
});
