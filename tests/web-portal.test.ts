import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import {
  WebPortal,
  createWebPortal,
  type ArchiveSource,
  type WebEmailPort,
  createArchiveSource,
  type WebPortalOptions,
  type WebPortalStore,
  type WebRequest,
  type WebResponse,
  DiscordCommandService,
  type RapiAgent,
} from "@rapi/agent";
import {
  hashWebSessionId,
  signWebUnsubscribe,
  verifyWebUnsubscribe,
  webRole,
  webUnsubscribeKey,
} from "@rapi/core";
import { loadEnvironment } from "../packages/config/src/index.js";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";

const SECRET = "s".repeat(40);
const USER = "123456789012345678";
const ADMIN = "223456789012345678";
const OWNER = "323456789012345678";
const allowlists = {
  userIds: [],
  superadminUserIds: [OWNER],
  adminUserIds: [ADMIN],
};

function harness(
  overrides: Partial<WebPortalOptions> = {},
  archiveOverride?: ArchiveSource,
) {
  let now = new Date("2026-10-26T00:00:00Z");
  const sessions = new Map<string, { userId: string; expiresAt: Date }>();
  const accounts = new Map<
    string,
    { username: string; displayName: string | null }
  >();
  const subscriptions = new Map<
    string,
    { cadence: "daily" | "weekly"; active: boolean }
  >();
  const calls: string[] = [];
  const store: WebPortalStore = {
    async upsertAccount(input) {
      accounts.set(input.userId, input);
      return input;
    },
    async createSession(idHash, userId, _now, expiresAt) {
      sessions.set(idHash, { userId, expiresAt });
    },
    async sessionAccount(idHash, at) {
      const session = sessions.get(idHash);
      const account = session && accounts.get(session.userId);
      return session && account && session.expiresAt > at
        ? { userId: session.userId, ...account }
        : null;
    },
    async deleteSession(idHash) {
      sessions.delete(idHash);
    },
    async learnerSubscription(userId) {
      return subscriptions.get(userId) ?? null;
    },
  };
  // Same semantics as the PostgresStore learner methods the Discord buttons use.
  const learner = {
    async learnerSubscribe(input: {
      userId: string;
      guildId: string | null;
      cadence: "daily" | "weekly";
    }) {
      calls.push(`subscribe:${input.userId}:${input.guildId}:${input.cadence}`);
      subscriptions.set(input.userId, { cadence: input.cadence, active: true });
    },
    async learnerSetCadence(userId: string, cadence: "daily" | "weekly") {
      calls.push(`cadence:${userId}:${cadence}`);
      const current = subscriptions.get(userId);
      if (!current?.active) return false;
      current.cadence = cadence;
      return true;
    },
    async learnerOptOut(userId: string) {
      calls.push(`optout:${userId}`);
      const current = subscriptions.get(userId);
      if (!current?.active) return false;
      current.active = false;
      return true;
    },
  };
  const archive: ArchiveSource = {
    async list() {
      return [
        {
          slug: "weekly-2026-10-19",
          cadence: "weekly",
          periodKey: "2026-10-19",
          sentAt: new Date("2026-10-19T01:00:00Z"),
          items: [],
        },
      ];
    },
    async get(slug) {
      return slug === "weekly-2026-10-19"
        ? {
            slug,
            cadence: "weekly",
            periodKey: "2026-10-19",
            sentAt: new Date("2026-10-19T01:00:00Z"),
            items: [
              {
                section: "core",
                title: "<b>제목</b>",
                summary: "요약 & 설명",
                url: "https://example.com/a?x=1&y=2",
              },
              {
                section: "tools",
                title: "도구",
                summary: "",
                url: "javascript:alert(1)",
              },
            ],
          }
        : null;
    },
  };
  const tokenRequests: URLSearchParams[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith("/oauth2/token")) {
      tokenRequests.push(new URLSearchParams(init?.body as URLSearchParams));
      return Response.json({ access_token: "tok" });
    }
    assert.ok(url.endsWith("/users/@me"));
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      "Bearer tok",
    );
    return Response.json({
      id: USER,
      username: "tester",
      global_name: "테스터",
    });
  };
  const portal = new WebPortal(store, learner, archiveOverride ?? archive, {
    baseUrl: "https://rapi.example.com/",
    clientId: "999",
    clientSecret: "client-secret",
    secret: SECRET,
    allowlists,
    learnerEnabled: true,
    emailEnabled: false,
    fetch: fakeFetch,
    now: () => now,
    ...overrides,
  });
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
  const cookiesOf = (response: WebResponse): string[] => {
    const raw = response.headers["set-cookie"];
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
  };
  /** Runs the whole login and returns the session cookie header plus the CSRF token. */
  async function login() {
    const start = await portal.handle(request("GET", "/auth/discord/login"));
    const oauthCookie = cookiesOf(start!)[0]!.split(";")[0]!;
    const state = new URL(String(start!.headers.location)).searchParams.get(
      "state",
    )!;
    const done = await portal.handle(
      request("GET", `/auth/discord/callback?code=abc&state=${state}`, {
        cookie: oauthCookie,
      }),
    );
    const cookie = cookiesOf(done!)
      .find(
        (value) =>
          value.startsWith("__Host-rapi_session=") &&
          !value.includes("Max-Age=0"),
      )!
      .split(";")[0]!;
    const page = await portal.handle(request("GET", "/me", { cookie }));
    const csrf = /name="csrf" value="([^"]+)"/.exec(page!.body)![1]!;
    return { cookie, csrf, state, done: done! };
  }
  return {
    portal,
    request,
    cookiesOf,
    login,
    calls,
    sessions,
    subscriptions,
    tokenRequests,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    clock: () => now,
  };
}

test("web role comes from the Discord allowlists and defaults to USER", () => {
  assert.equal(webRole(OWNER, allowlists), "SUPERADMIN");
  assert.equal(webRole(ADMIN, allowlists), "ADMIN");
  assert.equal(webRole(USER, allowlists), "USER");
  assert.equal(webRole(OWNER, { userIds: [OWNER] }), "SUPERADMIN");
});

test("login redirects to Discord with state and PKCE, then sets a hardened 30-day session", async () => {
  const h = harness();
  const start = await h.portal.handle(h.request("GET", "/auth/discord/login"));
  assert.equal(start!.status, 302);
  const location = new URL(String(start!.headers.location));
  assert.equal(
    location.origin + location.pathname,
    "https://discord.com/oauth2/authorize",
  );
  assert.equal(location.searchParams.get("scope"), "identify");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://rapi.example.com/auth/discord/callback",
  );
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(location.searchParams.get("code_challenge"));
  const oauthCookie = h.cookiesOf(start!)[0]!;
  assert.match(oauthCookie, /HttpOnly; Secure; SameSite=Lax/);

  const { done, cookie, state } = await h.login();
  assert.equal(done.status, 303);
  assert.equal(done.headers.location, "/me");
  const session = h
    .cookiesOf(done)
    .find((value) => value.startsWith("__Host-rapi_session="))!;
  for (const flag of [
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=2592000",
    "Path=/",
  ])
    assert.ok(session.includes(flag), flag);
  assert.ok(
    h
      .cookiesOf(done)
      .some(
        (value) =>
          value.startsWith("__Host-rapi_oauth=;") &&
          value.includes("Max-Age=0"),
      ),
  );
  // The token exchange carried the PKCE verifier; only the cookie's hash is stored.
  assert.ok(h.tokenRequests[0]!.get("code_verifier"));
  assert.equal(
    h.tokenRequests[0]!.get("redirect_uri"),
    "https://rapi.example.com/auth/discord/callback",
  );
  const raw = cookie.split("=")[1]!;
  assert.deepEqual([...h.sessions.keys()], [hashWebSessionId(raw)]);
  assert.notEqual(state, raw);
});

test("callback rejects a missing, forged, mismatched or expired state", async () => {
  const h = harness();
  const start = await h.portal.handle(h.request("GET", "/auth/discord/login"));
  const oauthCookie = h.cookiesOf(start!)[0]!.split(";")[0]!;
  const state = new URL(String(start!.headers.location)).searchParams.get(
    "state",
  )!;
  const attempt = (query: string, cookie?: string) =>
    h.portal.handle(
      h.request(
        "GET",
        `/auth/discord/callback?${query}`,
        cookie ? { cookie } : {},
      ),
    );
  assert.equal((await attempt(`code=x&state=${state}`))!.status, 400);
  assert.equal(
    (await attempt(`code=x&state=${"A".repeat(32)}`, oauthCookie))!.status,
    400,
  );
  assert.equal((await attempt("code=x", oauthCookie))!.status, 400);
  const tampered = oauthCookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal((await attempt(`code=x&state=${state}`, tampered))!.status, 400);
  assert.equal(
    (await attempt(`error=access_denied&state=${state}`, oauthCookie))!.status,
    400,
  );
  h.advance(11 * 60_000);
  assert.equal(
    (await attempt(`code=x&state=${state}`, oauthCookie))!.status,
    400,
  );
  assert.equal(h.tokenRequests.length, 0);
  assert.equal(h.sessions.size, 0);
});

test("a session stops working after its 30 days, and logout ends it earlier", async () => {
  const h = harness();
  const { cookie } = await h.login();
  assert.equal(
    (await h.portal.handle(h.request("GET", "/me", { cookie })))!.status,
    200,
  );
  h.advance(29 * 86_400_000);
  assert.equal(
    (await h.portal.handle(h.request("GET", "/me", { cookie })))!.status,
    200,
  );
  h.advance(2 * 86_400_000);
  const expired = await h.portal.handle(h.request("GET", "/me", { cookie }));
  assert.equal(expired!.status, 401);
  assert.match(expired!.body, /Discord로 로그인/);

  const second = await h.login();
  const refused = await h.portal.handle(
    h.request("POST", "/logout", {
      cookie: second.cookie,
      form: { csrf: "bad" },
    }),
  );
  assert.equal(refused!.status, 403);
  assert.equal(h.sessions.size, 2);
  const out = await h.portal.handle(
    h.request("POST", "/logout", {
      cookie: second.cookie,
      form: { csrf: second.csrf },
    }),
  );
  assert.equal(out!.status, 303);
  assert.match(h.cookiesOf(out!)[0]!, /Max-Age=0/);
  assert.equal(
    (await h.portal.handle(h.request("GET", "/me", { cookie: second.cookie })))!
      .status,
    401,
  );
});

test("pages carry a nonce-only CSP without scripts", async () => {
  const h = harness();
  const { cookie } = await h.login();
  const page = await h.portal.handle(h.request("GET", "/me", { cookie }));
  const csp = String(page!.headers["content-security-policy"]);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.doesNotMatch(page!.body, /<script/);
  assert.equal(page!.headers["cache-control"], "no-store");
  assert.match(page!.body, /이메일 \(준비 중\)/);
  assert.match(page!.body, /name="channel" value="email" disabled/);
});

test("subscribing on the web writes the same learner rows the Discord buttons use", async () => {
  const h = harness();
  const { cookie, csrf } = await h.login();
  const post = (form: Record<string, string>) =>
    h.portal.handle(h.request("POST", "/me/subscription", { cookie, form }));
  const base = { csrf, track: "learner", channel: "discord_dm" };

  assert.equal(
    (await post({ ...base, action: "subscribe", cadence: "daily" }))!.headers
      .location,
    "/me?m=subscribed",
  );
  assert.deepEqual(h.subscriptions.get(USER), {
    cadence: "daily",
    active: true,
  });
  assert.equal(
    (await post({ ...base, action: "subscribe", cadence: "weekly" }))!.headers
      .location,
    "/me?m=changed",
  );
  assert.deepEqual(h.subscriptions.get(USER), {
    cadence: "weekly",
    active: true,
  });
  const shown = await h.portal.handle(h.request("GET", "/me", { cookie }));
  assert.match(shown!.body, /매주 받는 중/);
  assert.equal(
    (await post({ ...base, action: "unsubscribe", cadence: "weekly" }))!.headers
      .location,
    "/me?m=unsubscribed",
  );
  assert.equal(h.subscriptions.get(USER)!.active, false);
  assert.deepEqual(h.calls, [
    `subscribe:${USER}:null:daily`,
    `cadence:${USER}:weekly`,
    `optout:${USER}`,
  ]);
  // Subscribing again after an opt-out re-activates the same row.
  await post({ ...base, action: "subscribe", cadence: "daily" });
  assert.equal(h.subscriptions.get(USER)!.active, true);
});

test("subscription forms need the session's CSRF token and valid choices", async () => {
  const h = harness();
  const { cookie, csrf } = await h.login();
  const post = (form: Record<string, string>) =>
    h.portal.handle(h.request("POST", "/me/subscription", { cookie, form }));
  const good = {
    track: "learner",
    channel: "discord_dm",
    action: "subscribe",
    cadence: "daily",
  };
  assert.equal((await post(good))!.headers.location, "/me?m=csrf");
  assert.equal(
    (await post({ ...good, csrf: "x".repeat(43) }))!.headers.location,
    "/me?m=csrf",
  );
  assert.equal(
    (await post({ ...good, csrf, cadence: "hourly" }))!.headers.location,
    "/me?m=bad",
  );
  assert.equal(
    (await post({ ...good, csrf, track: "other" }))!.headers.location,
    "/me?m=bad",
  );
  assert.equal(
    (await post({ ...good, csrf, channel: "email" }))!.headers.location,
    "/me?m=email",
  );
  assert.deepEqual(h.calls, []);
  // Another session's token does not work.
  const other = await h.login();
  assert.equal(
    (await post({ ...good, csrf: other.csrf }))!.headers.location,
    "/me?m=csrf",
  );
  const anonymous = await h.portal.handle(
    h.request("POST", "/me/subscription", { form: { ...good, csrf } }),
  );
  assert.equal(anonymous!.status, 401);
  assert.deepEqual(h.calls, []);
});

test("the form stays inert while the learner experiment is off", async () => {
  const h = harness({ learnerEnabled: false });
  const { cookie, csrf } = await h.login();
  const shown = await h.portal.handle(h.request("GET", "/me", { cookie }));
  assert.match(
    shown!.body,
    /type="submit" name="action" value="subscribe" disabled/,
  );
  const result = await h.portal.handle(
    h.request("POST", "/me/subscription", {
      cookie,
      form: {
        csrf,
        track: "learner",
        channel: "discord_dm",
        action: "subscribe",
        cadence: "daily",
      },
    }),
  );
  assert.equal(result!.headers.location, "/me?m=off");
  assert.deepEqual(h.calls, []);
});

test("unsubscribe links work without a login and reject forged or expired tokens", async () => {
  const h = harness();
  const key = webUnsubscribeKey(SECRET);
  const token = signWebUnsubscribe(key, USER, h.clock());
  assert.deepEqual(verifyWebUnsubscribe(key, token, h.clock()), {
    userId: USER,
  });
  assert.equal(
    h.portal.unsubscribeUrl(USER).startsWith("https://rapi.example.com/u/"),
    true,
  );
  h.subscriptions.set(USER, { cadence: "daily", active: true });

  const confirm = await h.portal.handle(h.request("GET", `/u/${token}`));
  assert.equal(confirm!.status, 200);
  assert.match(
    confirm!.body,
    new RegExp(
      `<form method="post" action="/u/${token.replaceAll(".", "\\.")}">`,
    ),
  );
  assert.deepEqual(h.calls, [], "GET never unsubscribes");

  const done = await h.portal.handle(h.request("POST", `/u/${token}`));
  assert.equal(done!.status, 200);
  assert.match(done!.body, /해지했어요/);
  assert.deepEqual(h.calls, [`optout:${USER}`]);
  assert.equal(h.subscriptions.get(USER)!.active, false);
  assert.match(
    (await h.portal.handle(h.request("POST", `/u/${token}`)))!.body,
    /이미 해지된/,
  );

  const [id, expires, signature] = token.split(".");
  const forged = [
    `${ADMIN}.${expires}.${signature}`,
    `${id}.${Number(expires) + 1}.${signature}`,
    `${id}.${expires}.${"A".repeat(43)}`,
    "garbage",
  ];
  for (const bad of forged) {
    assert.equal(
      (await h.portal.handle(h.request("GET", `/u/${bad}`)))!.status,
      404,
      bad,
    );
    assert.equal(
      (await h.portal.handle(h.request("POST", `/u/${bad}`)))!.status,
      404,
      bad,
    );
  }
  h.advance(181 * 86_400_000);
  assert.equal(
    (await h.portal.handle(h.request("GET", `/u/${token}`)))!.status,
    404,
  );
  assert.equal(
    (await h.portal.handle(h.request("POST", `/u/${token}`)))!.status,
    404,
  );
  assert.deepEqual(h.calls, [`optout:${USER}`, `optout:${USER}`]);
});

test("the archive is public, escapes content and drops unsafe links", async () => {
  const h = harness();
  const list = await h.portal.handle(h.request("GET", "/archive"));
  assert.equal(list!.status, 200);
  assert.match(list!.body, /href="\/archive\/weekly-2026-10-19"/);
  assert.doesNotMatch(list!.body, /noindex/);
  const issue = await h.portal.handle(
    h.request("GET", "/archive/weekly-2026-10-19"),
  );
  assert.equal(issue!.status, 200);
  assert.match(issue!.body, /&lt;b&gt;제목&lt;\/b&gt;/);
  assert.match(issue!.body, /요약 &amp; 설명/);
  assert.match(
    issue!.body,
    /href="https:\/\/example\.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer"/,
  );
  assert.doesNotMatch(issue!.body, /javascript:/);
  assert.equal(
    (await h.portal.handle(h.request("GET", "/archive/daily-2026-10-19")))!
      .status,
    404,
  );
  assert.equal(
    await h.portal.handle(h.request("GET", "/archive/..%2fx")),
    undefined,
  );
});

test("admin routes hang off the route table with requireRole semantics", async () => {
  const admin = {
    method: "GET" as const,
    pattern: /^\/me\/admin-probe$/,
    access: "ADMIN" as const,
    handler: async (context: { portal: WebPortal; account: unknown }) =>
      context.portal.page(undefined, { title: "probe", body: "<p>ok</p>" }),
  };
  const h = harness({ routes: [admin as never] });
  const user = await h.login();
  assert.equal(
    (await h.portal.handle(h.request("GET", "/me/admin-probe")))!.status,
    401,
  );
  assert.equal(
    (await h.portal.handle(
      h.request("GET", "/me/admin-probe", { cookie: user.cookie }),
    ))!.status,
    403,
  );
  // Promote the same session's account: roles are computed per request.
  const promoted = harness({
    routes: [admin as never],
    allowlists: { ...allowlists, adminUserIds: [USER] },
  });
  const session = await promoted.login();
  assert.equal(
    (await promoted.portal.handle(
      promoted.request("GET", "/me/admin-probe", { cookie: session.cookie }),
    ))!.status,
    200,
  );
});

test("paths outside the web area and unsupported methods are not handled", async () => {
  const h = harness();
  assert.equal(await h.portal.handle(h.request("GET", "/health")), undefined);
  assert.equal(
    await h.portal.handle(h.request("GET", "/interactions")),
    undefined,
  );
  assert.equal(
    await h.portal.handle(h.request("GET", "/me/unknown")),
    undefined,
  );
  assert.equal((await h.portal.handle(h.request("PUT", "/me")))!.status, 405);
});

test("web stays off unless WEB_ENABLED and every credential are set", async () => {
  const base = {
    RAPI_ENV: "test",
    DATABASE_URL: "postgresql://rapi:rapi@localhost:5432/rapi",
    DISCORD_BOT_TOKEN: "t",
    DISCORD_APPLICATION_ID: "1234567890",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    DISCORD_ALLOWED_USER_IDS: "100",
  };
  const config = loadEnvironment(base);
  assert.equal(config.WEB_ENABLED, false);
  assert.equal(config.EMAIL_ENABLED, false);
  assert.equal(
    createWebPortal(config, allowlists, {} as never, {} as never),
    undefined,
  );
  assert.throws(
    () => loadEnvironment({ ...base, WEB_ENABLED: "true" }),
    /WEB_ENABLED requires/,
  );
  const on = loadEnvironment({
    ...base,
    WEB_ENABLED: "true",
    DISCORD_OAUTH_CLIENT_ID: "999",
    DISCORD_OAUTH_CLIENT_SECRET: "secret",
    RAPI_PUBLIC_BASE_URL: "https://rapi.example.com",
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  assert.ok(createWebPortal(on, allowlists, {} as never, {} as never));

  // Without an integration the bot server answers 404 for every web path.
  const bot = createDiscordInteractionServer(
    new DiscordCommandService({} as RapiAgent, { userIds: [] }),
    "a".repeat(64),
    {},
  );
  bot.listen(0, "127.0.0.1");
  await once(bot, "listening");
  const address = bot.address();
  assert.ok(address && typeof address === "object");
  try {
    for (const path of [
      "/me",
      "/archive",
      "/archive/weekly-2026-10-19",
      "/auth/discord/login",
      "/u/x",
    ])
      assert.equal(
        (await fetch(`http://127.0.0.1:${address.port}${path}`)).status,
        404,
        path,
      );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${address.port}/logout`, {
          method: "POST",
        })
      ).status,
      404,
    );
  } finally {
    bot.closeAllConnections();
    await new Promise<void>((resolve) => bot.close(() => resolve()));
  }
});

function publishedPost(slug: string, kind: "guide" | "issue" = "guide") {
  return {
    slug,
    kind,
    title: `글 ${slug}`,
    description: "설명",
    mdx: [
      "---",
      'title: "x"',
      "---",
      "",
      `# 글 ${slug}`,
      "",
      "## 소제목",
      "",
      "본문 &#60;script&#62;alert(1)&#60;/script&#62; 입니다.",
      "",
      "- [참고](https://example.com/a)",
      "- [나쁨](javascript:alert(1))",
      "",
    ].join("\n"),
    publishedAt: new Date("2026-10-20T00:00:00Z"),
  };
}

test("the archive lists published guides next to issues and never a withdrawn one", async () => {
  const published = [
    publishedPost("guide-one"),
    publishedPost("learner-x", "issue"),
  ];
  const blog = {
    // The store only returns published posts; a withdrawn slug is simply absent.
    async listPublishedBlogPosts() {
      return published;
    },
    async getBlogPost(slug: string) {
      return published.find((post) => post.slug === slug) ?? null;
    },
  };
  const issues = {
    async archiveIssues() {
      return [
        {
          slug: "weekly-2026-10-19",
          cadence: "weekly" as const,
          periodKey: "2026-10-19",
          sentAt: new Date("2026-10-19T01:00:00Z"),
          items: [],
        },
      ];
    },
    async archiveIssue() {
      return null;
    },
  };
  const h = harness({}, createArchiveSource(issues, blog));
  const list = await h.portal.handle(h.request("GET", "/archive"));
  assert.match(list!.body, /href="\/archive\/blog\/guide-one"/);
  assert.match(list!.body, /href="\/archive\/weekly-2026-10-19"/);
  // Issue posts duplicate the learner issues, so they are not listed twice.
  assert.doesNotMatch(list!.body, /learner-x/);
  // Newest first: the guide (10-20) precedes the issue (10-19).
  assert.ok(
    list!.body.indexOf("guide-one") < list!.body.indexOf("weekly-2026-10-19"),
  );
  const post = await h.portal.handle(
    h.request("GET", "/archive/blog/guide-one"),
  );
  assert.equal(post!.status, 200);
  assert.match(post!.body, /<h2>소제목<\/h2>/);
  assert.doesNotMatch(post!.body, /<script/);
  assert.match(post!.body, /&lt;script&gt;/);
  assert.match(
    post!.body,
    /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">참고<\/a>/,
  );
  assert.doesNotMatch(post!.body, /javascript:/);
  // Withdrawn (absent from the store) and unknown slugs are the same 404.
  published.splice(0, published.length);
  const gone = await h.portal.handle(
    h.request("GET", "/archive/blog/guide-one"),
  );
  assert.equal(gone!.status, 404);
  assert.doesNotMatch(
    (await h.portal.handle(h.request("GET", "/archive")))!.body,
    /guide-one/,
  );
});

test("an issue-only archive source keeps working without blog posts", async () => {
  const h = harness();
  assert.equal(
    (await h.portal.handle(h.request("GET", "/archive/blog/anything")))!.status,
    404,
  );
});

test("/me adds, shows and removes an email address behind CSRF", async () => {
  const sent: string[] = [];
  let stored: { address: string; state: "pending" | "verified" } | null = null;
  const email: WebEmailPort = {
    async status() {
      return stored
        ? {
            masked: stored.address.replace(/^(.).*(@.*)$/, "$1***$2"),
            state: stored.state,
          }
        : null;
    },
    async register(userId, address) {
      sent.push(`register:${userId}:${address}`);
      stored = { address, state: "pending" };
      return "확인 메일을 보냈어요.";
    },
    async remove(userId) {
      sent.push(`remove:${userId}`);
      const had = stored !== null;
      stored = null;
      return had;
    },
  };
  const h = harness({ emailEnabled: true, email });
  const { cookie, csrf } = await h.login();
  const post = (form: Record<string, string>) =>
    h.portal.handle(h.request("POST", "/me/email", { cookie, form }));

  const initial = await h.portal.handle(h.request("GET", "/me", { cookie }));
  assert.match(initial!.body, /등록한 주소가 없어요/);
  assert.doesNotMatch(initial!.body, /준비 중/);

  // No token, a wrong token, or no session never reaches the email service.
  assert.equal(
    (await post({ action: "add", address: "a@example.com" }))!.headers.location,
    "/me?m=csrf",
  );
  assert.equal(
    (await post({
      action: "add",
      address: "a@example.com",
      csrf: "x".repeat(43),
    }))!.headers.location,
    "/me?m=csrf",
  );
  const anonymous = await h.portal.handle(
    h.request("POST", "/me/email", {
      form: { action: "add", address: "a@example.com", csrf },
    }),
  );
  assert.equal(anonymous!.status, 401);
  assert.deepEqual(sent, []);

  const added = await post({
    csrf,
    action: "add",
    address: "  secret@example.com ",
  });
  assert.equal(added!.status, 200);
  assert.match(added!.body, /확인 메일을 보냈어요/);
  assert.match(added!.body, /s\*\*\*@example\.com/);
  assert.match(added!.body, /확인 대기 중/);
  assert.doesNotMatch(added!.body, /secret@example\.com/);
  assert.deepEqual(sent, ["register:" + USER + ":secret@example.com"]);

  const bad = await post({ csrf, action: "add", address: "" });
  assert.match(bad!.body, /메일 주소를 확인하지 못했어요/);
  assert.equal(sent.length, 1);

  const removed = await post({ csrf, action: "remove" });
  assert.match(removed!.body, /메일 주소를 지웠어요/);
  assert.deepEqual(sent.at(-1), "remove:" + USER);
  assert.match(removed!.body, /등록한 주소가 없어요/);
});

test("/me keeps the old placeholder when no email service exists", async () => {
  const h = harness({ emailEnabled: false });
  const { cookie, csrf } = await h.login();
  const page = await h.portal.handle(h.request("GET", "/me", { cookie }));
  assert.match(page!.body, /이메일 \(준비 중\)/);
  assert.doesNotMatch(page!.body, /\/me\/email/);
  const reply = await h.portal.handle(
    h.request("POST", "/me/email", {
      cookie,
      form: { csrf, action: "add", address: "a@example.com" },
    }),
  );
  assert.equal(reply!.headers.location, "/me?m=email");
});
