import assert from "node:assert/strict";
import { test } from "node:test";
import { establishesGatewaySession } from "../apps/chat/src/gateway-state.js";

test("READY and RESUMED both establish a healthy Discord Gateway session", () => {
  assert.equal(establishesGatewaySession("READY"), true);
  assert.equal(establishesGatewaySession("RESUMED"), true);
  assert.equal(establishesGatewaySession("MESSAGE_CREATE"), false);
  assert.equal(establishesGatewaySession(undefined), false);
});
