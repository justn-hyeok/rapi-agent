import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedGuildIds,
  assertDiscordAccess,
  assertDiscordScope,
  chatOpsExecutionAllowed,
  createGuildGate,
  decideGuildAdmission,
  isGuildAllowed,
  resolveDiscordAccess,
  resolveHomeGuildId,
  selectFeedTargets,
} from "@rapi/core";
import {
  DiscordCommandService,
  CommunityFeeds,
  type RapiAgent,
} from "@rapi/agent";
import type { PostgresStore } from "@rapi/db";
import type { ChatOpsStore } from "@rapi/db";
import { ChatOrchestrator } from "../apps/chat/src/orchestrator.js";
import type { Executor } from "../apps/chat/src/executor.js";

const ADMINISTRATOR = "8";
const policy = {
  userIds: ["owner"],
  adminUserIds: ["listed-admin"],
  adminRoleIds: ["admin-role"],
  homeGuildId: "home",
};

describe("admin scope", () => {
  const cases: Array<{
    name: string;
    identity: Parameters<typeof resolveDiscordAccess>[0];
    scope: "global" | "guild";
  }> = [
    {
      name: "Administrator permission in the home guild",
      identity: {
        userId: "u",
        guildId: "home",
        guildPermissions: ADMINISTRATOR,
      },
      scope: "global",
    },
    {
      name: "Administrator permission in a DM-less home role",
      identity: { userId: "u", guildId: "home", roleIds: ["admin-role"] },
      scope: "global",
    },
    {
      name: "Administrator permission in another guild",
      identity: {
        userId: "u",
        guildId: "other",
        guildPermissions: ADMINISTRATOR,
      },
      scope: "guild",
    },
    {
      name: "admin role in another guild",
      identity: { userId: "u", guildId: "other", roleIds: ["admin-role"] },
      scope: "guild",
    },
    {
      name: "admin user ID in another guild",
      identity: { userId: "listed-admin", guildId: "other" },
      scope: "global",
    },
    {
      name: "admin user ID with Administrator permission in another guild",
      identity: {
        userId: "listed-admin",
        guildId: "other",
        guildPermissions: ADMINISTRATOR,
      },
      scope: "global",
    },
  ];
  for (const item of cases)
    it(`${item.name} is ${item.scope}`, () => {
      const access = resolveDiscordAccess(item.identity, policy);
      assert.equal(access.level, "admin");
      assert.equal(access.scope, item.scope);
    });

  it("keeps SUPERADMIN global everywhere and the old API unchanged", () => {
    const identity = { userId: "owner", guildId: "other" };
    assert.deepEqual(resolveDiscordAccess(identity, policy), {
      level: "superadmin",
      scope: "global",
    });
    assert.equal(assertDiscordAccess(identity, policy), "superadmin");
    assert.equal(
      assertDiscordAccess(
        { userId: "u", guildId: "other", guildPermissions: ADMINISTRATOR },
        policy,
      ),
      "admin",
    );
  });

  it("treats DMs as global and everything as global without a home guild", () => {
    assert.equal(
      resolveDiscordAccess({ userId: "listed-admin" }, policy).scope,
      "global",
    );
    assert.equal(
      resolveDiscordAccess(
        { userId: "u", guildId: "other", guildPermissions: ADMINISTRATOR },
        { userIds: ["owner"] },
      ).scope,
      "global",
    );
  });

  it("asserts the scope", () => {
    assert.throws(
      () => assertDiscordScope({ level: "admin", scope: "guild" }, "global"),
      /운영자 서버/,
    );
    assertDiscordScope({ level: "admin", scope: "guild" }, "guild");
    assertDiscordScope({ level: "admin", scope: "global" }, "global");
  });
});

describe("commands by scope", () => {
  const calls: string[] = [];
  const service = new DiscordCommandService(
    {
      store: { enableChatChannel: async () => void calls.push("chat") },
    } as unknown as RapiAgent,
    policy,
    {
      status: async () => "ok",
      guildAllowlist: async () => ["home", "other"],
      usage: {
        status: async () => "",
        policy: async () => "policy",
        update: async () => {
          calls.push("usage");
          return "updated";
        },
      },
    },
  );
  const adminInOther = {
    userId: "u",
    guildId: "other",
    channelId: "c",
    guildPermissions: ADMINISTRATOR,
  };

  it("lets a guild admin run guild-scoped commands only", async () => {
    await service.execute(adminInOther, { name: "chat_enable", options: {} });
    await service.execute(adminInOther, {
      name: "usage_policy",
      options: { action: "변경", userDailyLimit: 5 },
    });
    assert.deepEqual(calls, ["chat", "usage"]);
    for (const name of [
      "status",
      "sources",
      "deliveries",
      "subscribe",
    ] as const)
      await assert.rejects(
        service.execute(adminInOther, { name, options: {} }),
        /운영자 서버/,
      );
  });

  it("keeps global commands for the home guild and listed admins", async () => {
    assert.deepEqual(
      (
        await service.execute(
          { userId: "u", guildId: "home", guildPermissions: ADMINISTRATOR },
          { name: "status", options: {} },
        )
      ).messages,
      ["ok"],
    );
    assert.deepEqual(
      (
        await service.execute(
          { userId: "listed-admin", guildId: "other" },
          { name: "status", options: {} },
        )
      ).messages,
      ["ok"],
    );
  });

  it("does not let home admins change usage policy without SUPERADMIN", async () => {
    await assert.rejects(
      service.execute(
        { userId: "u", guildId: "home", guildPermissions: ADMINISTRATOR },
        {
          name: "usage_policy",
          options: { action: "변경", userDailyLimit: 5 },
        },
      ),
      /SUPERADMIN/,
    );
  });

  it("answers an unapproved guild with a short notice", async () => {
    await assert.rejects(
      service.execute(
        { userId: "owner", guildId: "stranger" },
        { name: "status", options: {} },
      ),
      /아직 허용되지 않은 서버입니다/,
    );
  });
});

describe("guild allowlist decisions", () => {
  it("resolves the home guild in order", () => {
    assert.equal(resolveHomeGuildId("1", "2", ["3"]), "1");
    assert.equal(resolveHomeGuildId(undefined, "2", ["3"]), "2");
    assert.equal(resolveHomeGuildId(undefined, undefined, ["3", "4"]), "3");
    assert.equal(
      resolveHomeGuildId(undefined, undefined, undefined),
      undefined,
    );
  });

  it("unions env, approved and home guilds", () => {
    assert.deepEqual(allowedGuildIds(["a"], ["b", "a"], "h")?.sort(), [
      "a",
      "b",
      "h",
    ]);
    assert.equal(allowedGuildIds(undefined, [], undefined), undefined);
    assert.equal(isGuildAllowed("x", ["a"]), false);
    assert.equal(isGuildAllowed("a", ["a"]), true);
    assert.equal(isGuildAllowed("x", undefined), true);
  });

  it("decides what to do when the gateway reports a guild", () => {
    assert.equal(decideGuildAdmission("g", ["g"], undefined), "none");
    assert.equal(decideGuildAdmission("g", undefined, undefined), "request");
    assert.equal(decideGuildAdmission("g", undefined, "pending"), "none");
    assert.equal(decideGuildAdmission("g", undefined, "allowed"), "none");
    assert.equal(decideGuildAdmission("g", undefined, "rejected"), "leave");
    assert.equal(decideGuildAdmission("g", undefined, "left"), "request");
  });

  it("caches the approved guilds until invalidated", async () => {
    let loads = 0;
    let at = 0;
    const gate = createGuildGate({
      envIds: ["a"],
      homeGuildId: undefined,
      load: async () => {
        loads += 1;
        return loads > 1 ? ["b"] : [];
      },
      ttlMs: 100,
      now: () => at,
    });
    assert.deepEqual(await gate.allowed(), ["a"]);
    assert.deepEqual(await gate.allowed(), ["a"]);
    assert.equal(loads, 1);
    gate.invalidate();
    assert.deepEqual(await gate.allowed(), ["a", "b"]);
    at = 500;
    await gate.allowed();
    assert.equal(loads, 3);
  });
});

describe("ChatOps outside the home guild", () => {
  it("allows execution only in the home guild", () => {
    assert.equal(chatOpsExecutionAllowed("home", "home"), true);
    assert.equal(chatOpsExecutionAllowed("other", "home"), false);
    assert.equal(chatOpsExecutionAllowed("other", undefined), true);
  });

  for (const content of ["라피야! 서버 재시작해줘", "라피야! 기억해줘: 비밀"]) {
    it(`refuses a SUPERADMIN request in another guild: ${content}`, async () => {
      const replies: string[] = [];
      const answers: string[] = [];
      const chat = new ChatOrchestrator(
        {} as ChatOpsStore,
        {} as Executor,
        async (_channel, text) => {
          replies.push(text);
        },
        {
          isAdminChannel: async () => true,
          answer: async (input) => {
            answers.push(input.text);
            return "답";
          },
        },
        undefined,
        "home",
      );
      await chat.receive(
        {
          id: "1",
          guild_id: "other",
          channel_id: "c",
          content,
          author: { id: "owner" },
        },
        "superadmin",
      );
      assert.deepEqual(answers, []);
      assert.match(replies[0] ?? "", /운영자 서버/);
    });
  }

  it("still answers questions from another guild", async () => {
    const replies: string[] = [];
    const chat = new ChatOrchestrator(
      {} as ChatOpsStore,
      {} as Executor,
      async (_channel, text) => {
        replies.push(text);
      },
      { isAdminChannel: async () => true, answer: async () => "답변" },
      undefined,
      "home",
    );
    await chat.receive(
      {
        id: "1",
        guild_id: "other",
        channel_id: "c",
        content: "라피야! 오늘 뉴스 알려줘",
        author: { id: "owner" },
      },
      "superadmin",
    );
    assert.deepEqual(replies, ["답변"]);
  });
});

describe("per-guild feeds", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, n));

  it("skips guilds that already got the post and guilds approved later", () => {
    assert.deepEqual(
      selectFeedTargets(
        day(10),
        [
          { guildId: "a", allowedSince: null },
          { guildId: "b", allowedSince: day(5) },
          { guildId: "c", allowedSince: day(12) },
          { guildId: "d", allowedSince: null },
          { guildId: "a", allowedSince: null },
        ],
        new Set(["d"]),
      ),
      ["a", "b"],
    );
  });

  function setup(
    targets: Array<{ guildId: string; allowedSince: Date | null }>,
  ) {
    const posted: Array<{ channel: string }> = [];
    const sentKeys = new Set<string>();
    const channels: Record<string, string> = {
      "home|curation_setup": "home-ch",
      "g2|curation_setup": "g2-ch",
    };
    const store = {
      communityPostExists: async () => false,
      recordCommunityPost: async () => undefined,
      managedDiscordResourceId: async (
        guild: string,
        _type: string,
        key: string,
      ) => channels[`${guild}|${key}`] ?? null,
      communityGuildPostSent: async (guild: string, key: string) =>
        sentKeys.has(`${guild}|${key}`),
      recordCommunityGuildPost: async (input: {
        guildId: string;
        key: string;
      }) => {
        sentKeys.add(`${input.guildId}|${input.key}`);
      },
    } as unknown as PostgresStore;
    const feeds = new CommunityFeeds(store, undefined, {
      guildId: "home",
      owner: "o",
      autoPost: { setup: true },
      guildTargets: async () => targets,
      post: async (channel) => {
        posted.push({ channel });
        return "m";
      },
    });
    return { feeds, posted };
  }

  it("posts to each allowed guild with the channel, once", async () => {
    const { feeds, posted } = setup([
      { guildId: "g2", allowedSince: null },
      { guildId: "g3", allowedSince: null },
      { guildId: "future", allowedSince: new Date(Date.now() + 3_600_000) },
    ]);
    const embeds = [{ title: "t" }];
    const publish = (
      feeds as unknown as {
        publish(feed: string, key: string, embeds: unknown[]): Promise<boolean>;
      }
    ).publish.bind(feeds);
    await publish("setup", "k1", embeds);
    assert.deepEqual(
      posted.map((p) => p.channel),
      ["home-ch", "g2-ch"],
    );
    // The same key again must not reach g2 twice.
    await publish("setup", "k1", embeds);
    assert.deepEqual(
      posted.map((p) => p.channel),
      ["home-ch", "g2-ch", "home-ch"],
    );
  });

  it("behaves as before when the community guild is the only guild", async () => {
    const { feeds, posted } = setup([{ guildId: "home", allowedSince: null }]);
    await (
      feeds as unknown as {
        publish(feed: string, key: string, embeds: unknown[]): Promise<boolean>;
      }
    ).publish("setup", "k", [{ title: "t" }]);
    assert.deepEqual(
      posted.map((p) => p.channel),
      ["home-ch"],
    );
  });
});
