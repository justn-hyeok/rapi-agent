import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRunDelivery } from "../workers/runtime/src/delivery-schedule.js";

test("delivery schedule follows the explicit enable switch", () => {
  assert.equal(shouldRunDelivery(true), true);
  assert.equal(shouldRunDelivery(false), false);
});
