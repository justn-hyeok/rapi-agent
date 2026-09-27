import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import {
  assessBackupStatus,
  createLocalHealthServer,
  decideHealthAlert,
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

  it("supports longer per-component failure thresholds", () => {
    const tracker = new HealthTransitionTracker(3, 2, {
      chat: { failureThreshold: 4 },
      omp: { failureThreshold: 1 },
    });
    assert.equal(tracker.observe("chat", false), undefined);
    assert.equal(tracker.observe("chat", false), undefined);
    assert.equal(tracker.observe("chat", false), undefined);
    assert.equal(tracker.observe("chat", false), "down");
    assert.equal(tracker.observe("omp", false), "down");
  });

  it("only reports recovery for a notified incident and cools down repeats", () => {
    const started = new Date("2026-09-10T10:00:00Z");
    const down = decideHealthAlert("down", undefined, started);
    assert.equal(down.notify, true);
    assert.equal(down.state.active, true);

    const recovered = decideHealthAlert(
      "recovered",
      down.state,
      new Date("2026-09-10T10:05:00Z"),
    );
    assert.equal(recovered.notify, true);
    assert.equal(recovered.state.active, false);

    const repeated = decideHealthAlert(
      "down",
      recovered.state,
      new Date("2026-09-10T10:30:00Z"),
    );
    assert.equal(repeated.notify, false);
    assert.equal(
      decideHealthAlert(
        "recovered",
        repeated.state,
        new Date("2026-09-10T10:35:00Z"),
      ).notify,
      false,
    );
    assert.equal(
      decideHealthAlert(
        "down",
        repeated.state,
        new Date("2026-09-10T11:00:00Z"),
      ).notify,
      true,
    );
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
