import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCommunityEnvironment } from "../scripts/configure-public-community.js";
import { PublicCommunityService } from "@rapi/agent";
import type { PostgresStore } from "@rapi/db";

test("disabled public questions do not reserve quota or start execution", async () => {
  let calls = 0;
  const store = {
    async reserveAiUsage() {
      calls++;
      throw new Error("unexpected quota reservation");
    },
  } as unknown as PostgresStore;
  const service = new PublicCommunityService(
    store,
    {
      async answer() {
        calls++;
        throw new Error("unexpected execution");
      },
    },
    false,
  );
  assert.match(
    (await service.answer({
      guildId: "guild",
      userId: "user",
      requestId: "message",
      tier: "user",
      text: "question",
    }))!,
    /준비 중/,
  );
  assert.equal(calls, 0);
});

test("public community configuration requires distinct managed roles and channels", () => {
  const resources = {
    user: "1",
    staff: "2",
    admin: "3",
    questions: "4",
    alerts: "5",
  };
  const updates = publicCommunityEnvironment("1545832299671847013", resources);
  assert.equal(updates.DISCORD_GUILD_MEMBERS_ARE_USERS, "false");
  assert.equal(updates.DISCORD_USER_ROLE_IDS, "1");
  assert.equal(updates.RAPI_ADMIN_CHANNEL_ID, "3");
  assert.ok(!("PUBLIC_AGENT_ENABLED" in updates));
  assert.throws(
    () => publicCommunityEnvironment("guild", resources),
    /guild ID/,
  );
  assert.throws(
    () => publicCommunityEnvironment("123", { ...resources, user: null }),
    /missing: user/,
  );
  assert.throws(
    () => publicCommunityEnvironment("123", { ...resources, staff: "1" }),
    /distinct/,
  );
  assert.throws(
    () => publicCommunityEnvironment("123", { ...resources, questions: "3" }),
    /distinct/,
  );
});
