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

test("tolerates a transient source failure but reports sustained failures", () => {
  assert.equal(
    assessSourceHealth([{ kind: "rss", active: true, failureCount: 1 }]).status,
    "ok",
  );
  assert.equal(
    assessSourceHealth([{ kind: "rss", active: true, failureCount: 2 }]).status,
    "ok",
  );
  assert.deepEqual(
    assessSourceHealth([
      { kind: "github", active: true, failureCount: 0 },
      { kind: "rss", active: true, failureCount: 3 },
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

test("delegated crawler sources require an actual recent successful capture", () => {
  assert.equal(
    assessSourceHealth([
      {
        kind: "aside",
        active: true,
        failureCount: 0,
        crawler: true,
        lastSuccessAt: null,
      },
    ]).status,
    "failed",
  );
  assert.equal(
    assessSourceHealth([
      {
        kind: "aside",
        active: true,
        failureCount: 0,
        crawler: true,
        lastSuccessAt: new Date(),
      },
    ]).status,
    "ok",
  );
  assert.equal(
    assessSourceHealth([
      {
        kind: "rss",
        active: true,
        failureCount: 0,
        crawler: true,
        lastSuccessAt: new Date(Date.now() - 3600000),
      },
    ]).status,
    "failed",
  );
});
