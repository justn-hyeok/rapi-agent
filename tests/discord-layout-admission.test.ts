import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DiscordLayoutManager,
  parseDiscordLayout,
  planDiscordLayout,
} from "@rapi/agent";
import type { PostgresStore } from "@rapi/db";

test("layout admission resolves the real bot ID and checks desired role hierarchy", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-layout-"));
  const source = await readFile(
    new URL(
      "../config/discord-community-1545832299671847013.yaml",
      import.meta.url,
    ),
    "utf8",
  );
  const layoutFile = join(root, "layout.yaml");
  await writeFile(layoutFile, source);
  const calls: string[] = [];
  let userPosition = 1;
  const store = {
    async listManagedDiscordResources() {
      return [];
    },
    async createDiscordLayoutPlan() {
      return "plan-1";
    },
  } as unknown as PostgresStore;
  const roles = () => [
    { id: "guild", name: "@everyone", permissions: "0", position: 0 },
    { id: "bot-role", name: "bot", permissions: "8", position: 10 },
    { id: "staff", name: "ADMIN", permissions: "8", position: 5 },
    { id: "user", name: "라피 USER", permissions: "0", position: userPosition },
  ];
  const manager = new DiscordLayoutManager(store, {
    botToken: "fixture",
    layoutFile,
    rest: {
      async request<T>(route: string): Promise<T> {
        calls.push(route);
        if (route === "/users/@me") return { id: "bot-id" } as T;
        if (route === "/guilds/guild/members/bot-id")
          return { roles: ["bot-role"] } as T;
        if (route === "/guilds/guild/roles") return roles() as T;
        if (route === "/guilds/guild/channels") return [] as T;
        throw new Error(`Unexpected Discord endpoint: ${route}`);
      },
    },
  });
  try {
    assert.equal((await manager.preview("guild", "owner")).planId, "plan-1");
    assert.ok(calls.includes("/guilds/guild/members/bot-id"));
    assert.ok(!calls.includes("/guilds/guild/members/@me"));
    userPosition = 11;
    await assert.rejects(manager.preview("guild", "owner"), /라피 USER.*위에/);
    const layout = parseDiscordLayout(source);
    const plan = planDiscordLayout(
      layout,
      {
        guildId: "guild",
        roles: roles(),
        channels: [{ id: "existing", name: "일반", type: 0, position: 0 }],
      },
      [],
    );
    assert.ok(
      !plan.actions.some(
        (action) =>
          action.kind === "delete_channel" ||
          ("id" in action && action.id === "existing"),
      ),
    );
    assert.ok(
      plan.adopted.some(
        (resource) => resource.key === "rapi_staff" && resource.id === "staff",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
