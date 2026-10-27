import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordLayoutManager } from "@rapi/agent";
import type { PostgresStore } from "@rapi/db";

function setup(existing: string | null) {
  const calls: Array<{ route: string; method: string; body: string }> = [];
  const saved: Array<{ key: string; discordId: string }> = [];
  const store = {
    async managedDiscordResourceId(_guild: string, type: string, key: string) {
      if (type === "channel" && key === "rapi_help") return "help-channel";
      if (type === "message" && key === "help") return existing;
      return null;
    },
    async upsertManagedDiscordResource(input: {
      key: string;
      discordId: string;
    }) {
      saved.push(input);
    },
  } as unknown as PostgresStore;
  const manager = new DiscordLayoutManager(store, {
    botToken: "fixture",
    layoutFile: "unused",
    rest: {
      async request<T>(route: string, init?: RequestInit): Promise<T> {
        calls.push({
          route,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : "",
        });
        return { id: "message-1" } as T;
      },
    },
  });
  return { manager, calls, saved };
}

test("the usage guide is posted once and then edited in place", async () => {
  const first = setup(null);
  await first.manager.ensureHelpMessage("guild");
  assert.equal(first.calls[0]!.method, "POST");
  assert.equal(first.calls[0]!.route, "/channels/help-channel/messages");
  const body = JSON.parse(first.calls[0]!.body) as {
    embeds: Array<{ title: string; fields: unknown[] }>;
  };
  assert.equal(body.embeds[0]!.title, "라피 사용 안내");
  assert.ok(body.embeds[0]!.fields.length >= 3);
  assert.deepEqual(first.saved, [{ ...first.saved[0]!, key: "help" }]);

  const again = setup("message-1");
  await again.manager.ensureHelpMessage("guild");
  assert.equal(again.calls[0]!.method, "PATCH");
  assert.equal(
    again.calls[0]!.route,
    "/channels/help-channel/messages/message-1",
  );
});
