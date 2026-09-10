import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import {
  assessBackupStatus,
  createLocalHealthServer,
  HealthTransitionTracker,
  summarizeReadiness,
  type ComponentHealth,
} from "@rapi/core";

describe("operational health", () => {
  it("reports an immediate backup failure and stale successful backups", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    assert.deepEqual(
      assessBackupStatus(
        {
          state: "failed",
          lastSuccessAt: "2026-09-10T03:00:00Z",
          lastFailureAt: "2026-09-10T11:59:00Z",
        },
        now,
      ),
      {
        healthy: false,
        lastSuccessAt: "2026-09-10T03:00:00Z",
        reason: "latest backup attempt failed",
      },
    );
    assert.equal(
      assessBackupStatus(
        { state: "success", lastSuccessAt: "2026-09-09T09:59:59Z" },
        now,
      ).healthy,
      false,
    );
    assert.equal(
      assessBackupStatus(
        { state: "success", lastSuccessAt: "2026-09-10T03:00:00Z" },
        now,
      ).healthy,
      true,
    );
  });

  it("opens after three failures and recovers after two successes", () => {
    const tracker = new HealthTransitionTracker(3, 2);
    assert.equal(tracker.observe("db", false), undefined);
    assert.equal(tracker.observe("db", false), undefined);
    assert.equal(tracker.observe("db", false), "down");
    assert.equal(tracker.observe("db", false), undefined);
    assert.equal(tracker.observe("db", true), undefined);
    assert.equal(tracker.observe("db", true), "recovered");
    assert.equal(tracker.observe("db", true), undefined);
  });

  it("does not alert on the initial healthy observation", () => {
    const tracker = new HealthTransitionTracker(3, 2);
    assert.equal(tracker.observe("bot", true), undefined);
    assert.equal(tracker.observe("bot", true), undefined);
  });

  it("marks failed and stale required components unavailable", () => {
    const now = new Date("2026-09-10T10:00:00Z");
    const components: ComponentHealth[] = [
      {
        name: "database",
        status: "ok",
        checkedAt: "2026-09-10T09:59:59Z",
        required: true,
      },
      {
        name: "worker",
        status: "ok",
        checkedAt: "2026-09-10T09:00:00Z",
        required: true,
      },
    ];
    const summary = summarizeReadiness(components, now, 60_000);
    assert.equal(summary.ready, false);
    assert.equal(summary.components[1]?.status, "unknown");
  });

  it("serves liveness separately from readiness on loopback", async () => {
    const server = createLocalHealthServer(0, () =>
      Promise.resolve({
        ready: false,
        checkedAt: new Date().toISOString(),
        components: [],
      }),
    );
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      assert.equal(
        (await fetch(`http://127.0.0.1:${address.port}/health`)).status,
        200,
      );
      assert.equal(
        (await fetch(`http://127.0.0.1:${address.port}/ready`)).status,
        503,
      );
    } finally {
      server.close();
    }
  });
});
