import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISCORD_WEB_PAGES,
  DiscordCommandService,
  WEB_ADMIN_NAV,
  WebPortal,
  webAdminRoutes,
  type RapiAgent,
  type WebPortalStore,
  type WebRequest,
} from "@rapi/agent";
import {
  hashWebSessionId,
  newWebSessionId,
  webCsrfToken,
  webSessionKey,
} from "@rapi/core";

const SECRET = "s".repeat(40);
const USER = "123456789012345678";
const ADMIN = "223456789012345678";
const OWNER = "323456789012345678";
const HOME = "423456789012345678";
const OTHER = "523456789012345678";
const BASE = "https://rapi.example.com";
const allowlists = {
  userIds: [],
  superadminUserIds: [OWNER],
  adminUserIds: [ADMIN],
  userUserIds: [USER],
  homeGuildId: HOME,
};

function harness() {
  const calls: string[] = [];
  const sessions = new Map<string, string>();
  const store: WebPortalStore = {
    async upsertAccount(input) {
      return input;
    },
    async createSession() {},
    async sessionAccount(idHash) {
      const userId = sessions.get(idHash);
      return userId
        ? { userId, username: `u${userId}`, displayName: null }
        : null;
    },
    async deleteSession() {},
    async learnerSubscription() {
      return null;
    },
  };
  const agent = {
    store: {
      async activeSourceIds() {
        return ["s1"];
      },
      async deactivateSubscription(owner: string, name: string) {
        calls.push(`unsubscribe:${owner}:${name}`);
        return true;
      },
      async sourceStatus() {
        return [{ id: "s1", state: "ok" }];
      },
      async deliveryStatus() {
        return [];
      },
    },
    async createSubscription(input: { name: string }) {
      calls.push(`subscribe:${input.name}`);
      return "sub-1";
    },
  } as unknown as RapiAgent;
  const operationsBase = {
    status: async () => "라피 상태: 정상",
    usage: {
      status: async (guildId: string, _user: string, tier: string) =>
        `사용량 ${guildId} ${tier}`,
      policy: async (guildId: string) => `정책 ${guildId}`,
      update: async (guildId: string, _actor: string, input: object) => {
        calls.push(`policy:${guildId}:${JSON.stringify(input)}`);
        return "AI 사용 정책을 변경했습니다.";
      },
    },
    serverConfig: {
      preview: async (guildId: string) => ({
        summary: `미리보기 ${guildId}`,
        planId: "plan-1",
      }),
      apply: async (guildId: string, _actor: string, planId: string) => {
        calls.push(`apply:${guildId}:${planId}`);
        return "서버 구성을 적용했습니다.";
      },
      export: async (guildId: string, format: string) =>
        `export ${guildId} ${format}`,
    },
    guildAllowlist: async () => [HOME],
    webhooks: {
      register: async (input: { name: string }) => {
        calls.push(`register:${input.name}`);
        return { id: "wh-2", endpoint: "https://x/y", secret: "once" };
      },
      list: async () => [
        {
          id: "wh-1",
          name: "<b>깃허브</b>",
          kind: "github_inbound",
          state: "active",
        },
      ],
      detail: async () => ({ id: "wh-1" }),
      test: async () => {
        calls.push("test");
      },
      setState: async (_g: string, id: string, state: string) => {
        calls.push(`state:${id}:${state}`);
        return true;
      },
    },
  };
  const commands = (webBaseUrl?: string) =>
    new DiscordCommandService(agent, allowlists, {
      ...operationsBase,
      ...(webBaseUrl ? { webBaseUrl } : {}),
    } as never);
  const portal = new WebPortal(
    store,
    {
      learnerSubscribe: async () => undefined,
      learnerSetCadence: async () => true,
      learnerOptOut: async () => true,
    } as never,
    { list: async () => [], get: async () => null },
    {
      baseUrl: BASE,
      clientId: "1",
      clientSecret: "x",
      secret: SECRET,
      allowlists,
      learnerEnabled: true,
      emailEnabled: false,
      routes: webAdminRoutes({
        commands: commands(),
        guilds: async () => [HOME],
        homeGuildId: HOME,
      }),
      nav: WEB_ADMIN_NAV,
    },
  );
  function session(userId: string) {
    const id = newWebSessionId();
    sessions.set(hashWebSessionId(id), userId);
    return {
      cookie: `__Host-rapi_session=${id}`,
      csrf: webCsrfToken(webSessionKey(SECRET), id),
    };
  }
  const request = (
    method: string,
    target: string,
    options: { cookie?: string; form?: Record<string, string> } = {},
  ): WebRequest => {
    const url = new URL(target, "http://local");
    return {
      method,
      path: url.pathname,
      query: url.searchParams,
      cookie: options.cookie,
      form: new URLSearchParams(options.form),
    };
  };
  return { portal, session, request, calls, commands };
}

const GET_PAGES: Array<[string, string]> = [
  ["/admin/subscribe", "ADMIN"],
  ["/admin/unsubscribe", "ADMIN"],
  ["/admin/sources", "ADMIN"],
  ["/admin/deliveries", "ADMIN"],
  ["/admin/status", "ADMIN"],
  ["/admin/usage", "USER"],
  ["/admin/usage-policy", "ADMIN"],
  ["/admin/server-config", "SUPERADMIN"],
  ["/admin/webhooks", "SUPERADMIN"],
];

test("every admin page enforces the role of its slash command", async () => {
  const h = harness();
  const rank: Record<string, number> = { USER: 1, ADMIN: 2, SUPERADMIN: 3 };
  const users: Array<[string, number]> = [
    [USER, 1],
    [ADMIN, 2],
    [OWNER, 3],
  ];
  for (const [path, role] of GET_PAGES) {
    const anon = await h.portal.handle(h.request("GET", path));
    assert.equal(anon!.status, 401, `anon ${path}`);
    for (const [userId, level] of users) {
      const { cookie } = h.session(userId);
      const guild = `?guild=${HOME}`;
      const reply = await h.portal.handle(
        h.request("GET", path + guild, { cookie }),
      );
      if (level < rank[role]!)
        assert.equal(reply!.status, 403, `${userId} ${path}`);
      else
        assert.equal(reply!.status, 200, `${userId} ${path}: ${reply!.body}`);
    }
  }
});

test("pages show the command output and reuse the slash command service", async () => {
  const h = harness();
  const { cookie } = h.session(OWNER);
  const status = await h.portal.handle(
    h.request("GET", "/admin/status", { cookie }),
  );
  assert.match(status!.body, /라피 상태: 정상/);
  const usage = await h.portal.handle(
    h.request("GET", `/admin/usage?guild=${HOME}`, { cookie }),
  );
  assert.match(usage!.body, new RegExp(`사용량 ${HOME} staff`));
  const sources = await h.portal.handle(
    h.request("GET", "/admin/sources", { cookie }),
  );
  assert.match(sources!.body, /&quot;state&quot;: &quot;ok&quot;/);
  const picker = await h.portal.handle(
    h.request("GET", "/admin/usage", { cookie }),
  );
  assert.match(picker!.body, /<select name="guild"/);
  assert.match(picker!.body, new RegExp(HOME));
});

test("guild settings respect the guild allowlist and the admin level", async () => {
  const h = harness();
  const owner = h.session(OWNER);
  const blocked = await h.portal.handle(
    h.request("GET", `/admin/usage-policy?guild=${OTHER}`, {
      cookie: owner.cookie,
    }),
  );
  assert.equal(blocked!.status, 403);
  assert.match(blocked!.body, /허용되지 않은 서버/);
  // A plain admin may read the policy but not change it (same as the slash command).
  const admin = h.session(ADMIN);
  const read = await h.portal.handle(
    h.request("GET", `/admin/usage-policy?guild=${HOME}`, {
      cookie: admin.cookie,
    }),
  );
  assert.equal(read!.status, 200);
  const change = await h.portal.handle(
    h.request("POST", "/admin/usage-policy", {
      cookie: admin.cookie,
      form: {
        csrf: admin.csrf,
        guild: HOME,
        userDailyLimit: "5",
        confirm: "1",
      },
    }),
  );
  assert.equal(change!.status, 403);
  assert.deepEqual(h.calls, []);
  // Guild picking without a valid ID never reaches the service.
  const bad = await h.portal.handle(
    h.request("POST", "/admin/usage-policy", {
      cookie: owner.cookie,
      form: {
        csrf: owner.csrf,
        guild: "abc",
        userDailyLimit: "5",
        confirm: "1",
      },
    }),
  );
  assert.equal(bad!.status, 400);
  assert.deepEqual(h.calls, []);
});

const POSTS: Array<[string, string, Record<string, string>]> = [
  ["USER", "/admin/subscribe", { name: "n" }],
  ["USER", "/admin/unsubscribe", { name: "n", confirm: "1" }],
  [
    "USER",
    "/admin/usage-policy",
    { guild: HOME, userDailyLimit: "5", confirm: "1" },
  ],
  ["USER", "/admin/server-config", { guild: HOME }],
  [
    "USER",
    "/admin/server-config",
    { guild: HOME, planId: "plan-1", confirm: "1" },
  ],
  ["USER", "/admin/webhooks", { guild: HOME, action: "register", name: "n" }],
  [
    "USER",
    "/admin/webhooks",
    { guild: HOME, action: "stop", id: "wh-1", confirm: "1" },
  ],
];

test("every admin POST needs a valid CSRF token and a logged-in role", async () => {
  const h = harness();
  const owner = h.session(OWNER);
  for (const [, path, form] of POSTS) {
    const missing = await h.portal.handle(
      h.request("POST", path, { cookie: owner.cookie, form }),
    );
    assert.equal(missing!.status, 403, `no csrf ${path}`);
    const wrong = await h.portal.handle(
      h.request("POST", path, {
        cookie: owner.cookie,
        form: { ...form, csrf: "x".repeat(43) },
      }),
    );
    assert.equal(wrong!.status, 403, `wrong csrf ${path}`);
    const anon = await h.portal.handle(h.request("POST", path, { form }));
    assert.equal(anon!.status, 401, `anon ${path}`);
    // A token from another session is rejected as well.
    const other = h.session(OWNER);
    const foreign = await h.portal.handle(
      h.request("POST", path, {
        cookie: owner.cookie,
        form: { ...form, csrf: other.csrf },
      }),
    );
    assert.equal(foreign!.status, 403, `foreign csrf ${path}`);
  }
  assert.deepEqual(h.calls, [], "nothing ran without a CSRF token");
  // Roles gate the POSTs too.
  const user = h.session(USER);
  const admin = h.session(ADMIN);
  for (const [, path, form] of POSTS) {
    const asUser = await h.portal.handle(
      h.request("POST", path, {
        cookie: user.cookie,
        form: { ...form, csrf: user.csrf },
      }),
    );
    assert.equal(asUser!.status, 403, `user ${path}`);
  }
  for (const path of ["/admin/server-config", "/admin/webhooks"]) {
    const asAdmin = await h.portal.handle(
      h.request("POST", path, {
        cookie: admin.cookie,
        form: { csrf: admin.csrf, guild: HOME, action: "register", name: "n" },
      }),
    );
    assert.equal(asAdmin!.status, 403, `admin ${path}`);
  }
  assert.deepEqual(h.calls, []);
});

test("subscribe and unsubscribe run the slash command logic; unsubscribe asks first", async () => {
  const h = harness();
  const { cookie, csrf } = h.session(ADMIN);
  const created = await h.portal.handle(
    h.request("POST", "/admin/subscribe", {
      cookie,
      form: { csrf, name: "아침", cadence: "매주" },
    }),
  );
  assert.equal(created!.status, 200);
  assert.match(created!.body, /구독을 저장했습니다: 아침/);
  const ask = await h.portal.handle(
    h.request("POST", "/admin/unsubscribe", {
      cookie,
      form: { csrf, name: "아침" },
    }),
  );
  assert.match(ask!.body, /해제할까요/);
  assert.match(ask!.body, /name="confirm" value="1"/);
  assert.deepEqual(h.calls, ["subscribe:아침"]);
  const confirmed = await h.portal.handle(
    h.request("POST", "/admin/unsubscribe", {
      cookie,
      form: { csrf, name: "아침", confirm: "1" },
    }),
  );
  assert.match(confirmed!.body, /구독을 해제했습니다/);
  assert.deepEqual(h.calls, ["subscribe:아침", `unsubscribe:${ADMIN}:아침`]);
});

test("policy changes, server config apply and webhook stop need a confirmation step", async () => {
  const h = harness();
  const { cookie, csrf } = h.session(OWNER);
  const post = (path: string, form: Record<string, string>) =>
    h.portal.handle(
      h.request("POST", path, { cookie, form: { csrf, ...form } }),
    );

  const askPolicy = await post("/admin/usage-policy", {
    guild: HOME,
    userDailyLimit: "7",
  });
  assert.match(askPolicy!.body, /바꿀까요/);
  assert.deepEqual(h.calls, []);
  await post("/admin/usage-policy", {
    guild: HOME,
    userDailyLimit: "7",
    confirm: "1",
  });
  assert.deepEqual(h.calls, [`policy:${HOME}:{"userDailyLimit":7}`]);

  const preview = await post("/admin/server-config", { guild: HOME });
  assert.match(preview!.body, /미리보기 /);
  assert.match(preview!.body, /name="planId" value="plan-1"/);
  const unconfirmed = await post("/admin/server-config", {
    guild: HOME,
    planId: "plan-1",
  });
  assert.equal(unconfirmed!.status, 400);
  assert.equal(h.calls.length, 1);
  await post("/admin/server-config", {
    guild: HOME,
    planId: "plan-1",
    confirm: "1",
  });
  assert.equal(h.calls.at(-1), `apply:${HOME}:plan-1`);

  const ask = await post("/admin/webhooks", {
    guild: HOME,
    action: "stop",
    id: "wh-1",
  });
  assert.match(ask!.body, /중지할까요/);
  assert.equal(h.calls.at(-1), `apply:${HOME}:plan-1`);
  await post("/admin/webhooks", {
    guild: HOME,
    action: "stop",
    id: "wh-1",
    confirm: "1",
  });
  assert.equal(h.calls.at(-1), "state:wh-1:disabled");
  await post("/admin/webhooks", { guild: HOME, action: "resume", id: "wh-1" });
  assert.equal(h.calls.at(-1), "state:wh-1:active");
  await post("/admin/webhooks", { guild: HOME, action: "test", id: "wh-1" });
  assert.equal(h.calls.at(-1), "test");
});

test("webhook page escapes names and shows a new secret once in the response", async () => {
  const h = harness();
  const { cookie, csrf } = h.session(OWNER);
  const list = await h.portal.handle(
    h.request("GET", `/admin/webhooks?guild=${HOME}`, { cookie }),
  );
  assert.ok(!list!.body.includes("<b>깃허브</b>"));
  assert.match(list!.body, /&lt;b&gt;깃허브&lt;\/b&gt;/);
  assert.match(
    String(list!.headers["content-security-policy"]),
    /default-src 'none'/,
  );
  const created = await h.portal.handle(
    h.request("POST", "/admin/webhooks", {
      cookie,
      form: {
        csrf,
        guild: HOME,
        action: "register",
        name: "새 연결",
        kind: "범용 수신",
      },
    }),
  );
  assert.match(created!.body, /비밀값\(지금 한 번만 표시\): once/);
  assert.equal(h.calls.at(-1), "register:새 연결");
});

test("the admin nav link is shown to ADMIN and above only", async () => {
  const h = harness();
  const asUser = await h.portal.handle(
    h.request("GET", "/admin", { cookie: h.session(USER).cookie }),
  );
  assert.ok(!asUser!.body.includes('href="/admin"'));
  assert.match(asUser!.body, /\/admin\/usage/);
  assert.ok(!asUser!.body.includes("/admin/webhooks"));
  const asOwner = await h.portal.handle(
    h.request("GET", "/admin", { cookie: h.session(OWNER).cookie }),
  );
  assert.match(asOwner!.body, /href="\/admin"/);
  assert.match(asOwner!.body, /\/admin\/webhooks/);
});

test("moved slash commands behave as before while the web is off", async () => {
  const h = harness();
  const off = h.commands();
  const status = await off.execute(
    { userId: OWNER },
    { name: "status", options: {} },
  );
  assert.deepEqual(status.messages, ["라피 상태: 정상"]);
  const sources = await off.execute(
    { userId: OWNER },
    { name: "sources", options: {} },
  );
  assert.match(sources.messages[0]!, /"state": "ok"/);
  assert.equal(status.data, undefined);
});

test("moved slash commands point to their web page while the web is on", async () => {
  const h = harness();
  const on = h.commands(`${BASE}/`);
  const identity = { userId: OWNER, guildId: HOME };
  for (const [name, page] of Object.entries(DISCORD_WEB_PAGES)) {
    const result = await on.execute(identity, {
      name: name as never,
      options: { action: "조회", name: "n" },
    });
    assert.equal(result.messages.length, 1, name);
    assert.ok(result.messages[0]!.includes(`${BASE}${page}`), name);
    assert.equal(result.data?.webNotice, true, name);
  }
  assert.equal(Object.keys(DISCORD_WEB_PAGES).length, 9);
  // Permission checks still run first, so the notice never leaks to the unauthorised.
  await assert.rejects(
    on.execute(
      { userId: USER, guildId: HOME },
      { name: "status", options: {} },
    ),
    /ADMIN 권한/,
  );
  // A preview button made before the web was on can still apply.
  const applied = await on.execute(identity, {
    name: "server_config",
    options: { action: "적용", planId: "plan-1", viaButton: true },
  });
  assert.equal(applied.messages[0], "서버 구성을 적용했습니다.");
  // The commands that stay on Discord are untouched.
  await assert.rejects(
    on.execute(
      { userId: ADMIN, guildId: HOME, channelId: "1" },
      { name: "cancel", options: {} },
    ),
    /SUPERADMIN/,
  );
});

test("/검색 adds the archive link only when the web is on", async () => {
  const search = (webBaseUrl?: string) => {
    const agent = {
      store: {
        searchPublic: async () => [
          { id: "1", title: "글", url: "https://a/b" },
        ],
      },
    } as unknown as RapiAgent;
    return new DiscordCommandService(agent, allowlists, {
      status: async () => "",
      ...(webBaseUrl ? { webBaseUrl } : {}),
    }).execute({ userId: USER }, { name: "search", options: { query: "q" } });
  };
  assert.deepEqual((await search()).messages, ["글\nhttps://a/b"]);
  const on = await search(BASE);
  assert.equal(
    on.messages.join(""),
    `글\nhttps://a/b\n\n웹에서 지난 소식 보기: ${BASE}/archive`,
  );
  assert.equal(on.data, undefined);
});

test("the operator briefing pages are not confused with the learner's 내 구독", async () => {
  const h = harness();
  const { cookie } = h.session(ADMIN);
  for (const [path, label] of [
    ["/admin/subscribe", "운영자 브리핑 구독"],
    ["/admin/unsubscribe", "운영자 브리핑 구독 해제"],
  ] as const) {
    const page = await h.portal.handle(h.request("GET", path, { cookie }));
    assert.equal(page!.status, 200);
    assert.ok(page!.body.includes(label), path);
  }
  const index = await h.portal.handle(h.request("GET", "/admin", { cookie }));
  assert.ok(index!.body.includes("운영자 브리핑 구독 해제"));
  assert.ok(!index!.body.includes("구독 만들기"));
});
