import assert from "node:assert/strict";
import { test } from "node:test";
import { assessSourceHealth } from "../workers/runtime/src/source-health.js";

test("does not count an active Aside source as a healthy collector", () => {
  assert.deepEqual(
    assessSourceHealth([{ kind: "aside", active: true, failureCount: 0 }]),
    {
      configured: 0,
      failing: 0,
      unsupported: 1,
      status: "failed",
      reason: "1 active source(s) are not collectable by this worker",
    },
  );
});

test("counts only supported active sources and their failures", () => {
  assert.deepEqual(
    assessSourceHealth([
      { kind: "github", active: true, failureCount: 0 },
      { kind: "rss", active: true, failureCount: 2 },
      { kind: "webhook", active: false, failureCount: 0 },
    ]),
    {
      configured: 2,
      failing: 1,
      unsupported: 0,
      status: "failed",
      reason: "1 supported source(s) failing",
    },
  );
});
