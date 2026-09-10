import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DiscordCommandService, type RapiAgent } from "@rapi/agent";

describe("Discord operations commands", () => {
  it("restricts status to admins and webhook management to superadmins", async () => {
    const calls: string[] = [];
    const service = new DiscordCommandService(
      {} as RapiAgent,
      {
        userIds: ["owner"],
        adminUserIds: ["admin"],
        guildIds: ["guild"],
      },
      {
        status: () => Promise.resolve("healthy"),
        webhooks: {
          register: () => Promise.resolve({ id: "connection" }),
          list: () => {
            calls.push("list");
            return Promise.resolve([
              {
                id: "connection",
                name: "github",
                kind: "github_inbound",
                state: "active",
              },
            ]);
          },
          detail: () => Promise.resolve({ id: "connection" }),
          test: () => Promise.resolve(),
          setState: () => Promise.resolve(true),
        },
      },
    );
    assert.deepEqual(
      await service.execute(
        { userId: "admin", guildId: "guild", channelId: "channel" },
        { name: "status", options: {} },
      ),
      { messages: ["healthy"] },
    );
    await assert.rejects(
      service.execute(
        { userId: "admin", guildId: "guild", channelId: "channel" },
        { name: "webhook", options: { action: "목록" } },
      ),
      /SUPERADMIN/,
    );
    const result = await service.execute(
      { userId: "owner", guildId: "guild", channelId: "channel" },
      { name: "webhook", options: { action: "목록" } },
    );
    assert.match(result.messages[0] ?? "", /github/);
    assert.deepEqual(calls, ["list"]);
  });
});
