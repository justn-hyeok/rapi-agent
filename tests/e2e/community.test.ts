import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresStore } from "@rapi/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/rapi_test")
  throw new Error("Community E2E requires rapi_test");

describe("community persistence", () => {
  it("atomically applies per-user and global AI limits", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      const now = new Date("2026-09-10T21:00:00.000Z");
      await store.upsertAiUsagePolicy({
        guildId: "guild",
        userDailyLimit: 2,
        userCooldownSeconds: 30,
        globalDailyLimit: 3,
        globalConcurrency: 2,
        timezone: "Asia/Seoul",
        resetHour: 5,
        resetMinute: 30,
      });
      const first = await store.reserveAiUsage({
        guildId: "guild",
        userId: "user",
        requestId: "message-1",
        tier: "user",
        now,
      });
      assert.equal(first.accepted, true);
      assert.equal(first.remaining, 1);
      assert.equal(
        (
          await store.reserveAiUsage({
            guildId: "guild",
            userId: "user",
            requestId: "message-1",
            tier: "user",
            now,
          })
        ).duplicate,
        true,
      );
      const cooldown = await store.reserveAiUsage({
        guildId: "guild",
        userId: "user",
        requestId: "message-2",
        tier: "user",
        now: new Date(now.getTime() + 10_000),
      });
      assert.equal(cooldown.accepted, false);
      assert.equal(cooldown.reason, "cooldown");
      await store.markAiUsageStarted("message-1");
      await store.finishAiUsage("message-1", "succeeded");
      const later = await store.reserveAiUsage({
        guildId: "guild",
        userId: "user",
        requestId: "message-2",
        tier: "user",
        now: new Date(now.getTime() + 31_000),
      });
      assert.equal(later.accepted, true);
      assert.equal(later.remaining, 0);
      assert.equal(
        (
          await store.reserveAiUsage({
            guildId: "guild",
            userId: "user",
            requestId: "message-3",
            tier: "user",
            now: new Date(now.getTime() + 62_000),
          })
        ).reason,
        "user_limit",
      );
    } finally {
      await store.close();
    }
  });

  it("does not limit staff and releases requests that never started", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      const now = new Date("2026-09-10T21:00:00.000Z");
      const staff = await store.reserveAiUsage({
        guildId: "guild",
        userId: "staff",
        requestId: "staff-1",
        tier: "staff",
        now,
      });
      assert.equal(staff.accepted, true);
      assert.equal(staff.remaining, null);
      await store.releaseAiUsage("staff-1");
      assert.equal((await store.aiUsageStatus("guild", "staff", now)).used, 0);
    } finally {
      await store.close();
    }
  });

  it("serializes concurrent reservations, enforces the global limit, and resets at 05:30", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      await store.upsertAiUsagePolicy({
        guildId: "guild",
        userDailyLimit: 10,
        userCooldownSeconds: 0,
        globalDailyLimit: 3,
        globalConcurrency: 2,
        timezone: "Asia/Seoul",
        resetHour: 5,
        resetMinute: 30,
      });
      const now = new Date("2026-09-10T20:30:00.000Z");
      const parallel = await Promise.all(
        ["one", "two"].map((requestId) =>
          store.reserveAiUsage({
            guildId: "guild",
            userId: requestId,
            requestId,
            tier: "user",
            requestDigest: `${requestId}-digest`,
            model: "gpt-5.3-codex-spark",
            now,
          }),
        ),
      );
      assert.equal(parallel.filter((item) => item.accepted).length, 2);
      assert.equal(
        (
          await store.reserveAiUsage({
            guildId: "guild",
            userId: "three",
            requestId: "three",
            tier: "user",
            now,
          })
        ).reason,
        "concurrency",
      );
      await Promise.all([
        store.finishAiUsage("one", "succeeded"),
        store.finishAiUsage("two", "failed", "timeout"),
      ]);
      assert.equal(
        (
          await store.reserveAiUsage({
            guildId: "guild",
            userId: "three",
            requestId: "three",
            tier: "user",
            now,
          })
        ).accepted,
        true,
      );
      await store.finishAiUsage("three", "succeeded");
      assert.equal(
        (
          await store.reserveAiUsage({
            guildId: "guild",
            userId: "four",
            requestId: "four",
            tier: "user",
            now,
          })
        ).reason,
        "global_limit",
      );
      const metadata = await store.pool.query<{
        request_digest: string;
        model: string;
      }>(
        "SELECT request_digest,model FROM ai_usage_events WHERE request_id='one'",
      );
      assert.deepEqual(metadata.rows[0], {
        request_digest: "one-digest",
        model: "gpt-5.3-codex-spark",
      });

      await store.upsertAiUsagePolicy({
        guildId: "boundary",
        userDailyLimit: 1,
        userCooldownSeconds: 0,
        globalDailyLimit: 10,
        globalConcurrency: 2,
        timezone: "Asia/Seoul",
        resetHour: 5,
        resetMinute: 30,
      });
      assert.equal(
        (
          await store.reserveAiUsage({
            guildId: "boundary",
            userId: "user",
            requestId: "before-reset",
            tier: "user",
            now: new Date("2026-09-10T20:29:59.000Z"),
          })
        ).accepted,
        true,
      );
      await store.finishAiUsage("before-reset", "succeeded");
      assert.equal(
        (
          await store.reserveAiUsage({
            guildId: "boundary",
            userId: "user",
            requestId: "after-reset",
            tier: "user",
            now: new Date("2026-09-10T20:30:00.000Z"),
          })
        ).accepted,
        true,
      );
    } finally {
      await store.close();
    }
  });

  it("stores one-use Discord layout plans and stable resource keys", async () => {
    const store = new PostgresStore(databaseUrl);
    try {
      await store.resetForTests();
      await store.upsertManagedDiscordResource({
        guildId: "guild",
        resourceType: "channel",
        key: "rapi_admin",
        discordId: "123",
        layoutDigest: "layout",
      });
      assert.equal(
        await store.managedDiscordResourceId("guild", "channel", "rapi_admin"),
        "123",
      );
      const planId = await store.createDiscordLayoutPlan({
        guildId: "guild",
        createdBy: "owner",
        layoutDigest: "layout",
        snapshotDigest: "snapshot",
        payload: { actions: [], adopted: [] },
        expiresAt: new Date(Date.now() + 600_000),
      });
      assert.equal(
        (await store.discordLayoutPlan("guild", planId))?.createdBy,
        "owner",
      );
      assert.equal(
        await store.markDiscordLayoutPlanApplied("guild", planId),
        true,
      );
      assert.equal(
        await store.markDiscordLayoutPlanApplied("guild", planId),
        false,
      );
    } finally {
      await store.close();
    }
  });
});
