import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  BillingService,
  DiscordCommandService,
  WebPortal,
  WEB_BILLING_NAV,
  createWebPortal,
  loadBillingPlans,
  parseBillingPlans,
  webBillingRoutes,
  type RapiAgent,
  type WebRequest,
  type WebResponse,
} from "@rapi/agent";
import {
  TossApiError,
  TossUncertainError,
  createTossClient,
  type TossClient,
  type TossPayment,
} from "@rapi/adapters";
import {
  allowsFeature,
  billingCustomerKey,
  extendEntitlement,
  isBillingOrderId,
  newBillingOrderId,
  planPurchasable,
  shortenEntitlement,
  type BillingPlan,
} from "@rapi/core";
import type { BillingOrder, BillingStorePort } from "@rapi/db";
import { deleteUserBilling } from "../scripts/privacy-lifecycle.mjs";
import { loadEnvironment } from "../packages/config/src/index.js";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";

const SECRET = "s".repeat(40);
const USER = "123456789012345678";
const DAY = 86_400_000;
const PLANS: BillingPlan[] = [
  {
    id: "supporter",
    name: "서포터",
    description: "후원 30일",
    priceKrw: 1000,
    periodDays: 30,
    features: ["pro"],
  },
  {
    id: "soon",
    name: "준비중",
    description: "곧",
    priceKrw: 0,
    periodDays: 30,
    features: [],
  },
];

/** In-memory store with the same state rules as BillingStore's SQL. */
function fakeStore() {
  const orders = new Map<string, BillingOrder>();
  const entitlements = new Map<
    string,
    { userId: string; planId: string; validUntil: Date; lastOrderId: string }
  >();
  const store: BillingStorePort = {
    async createOrder(input) {
      const order: BillingOrder = {
        orderId: input.orderId,
        userId: input.userId,
        planId: input.planId,
        amountKrw: input.amountKrw,
        status: "pending",
        paymentKey: null,
        method: null,
        createdAt: input.now,
        paidAt: null,
        canceledAt: null,
        cancelReason: null,
        rawStatus: null,
      };
      orders.set(order.orderId, order);
      return { ...order };
    },
    async getOrder(id) {
      const order = orders.get(id);
      return order ? { ...order } : null;
    },
    async getOrderByPaymentKey(key) {
      const order = [...orders.values()].find((o) => o.paymentKey === key);
      return order ? { ...order } : null;
    },
    async recentOrders() {
      return [...orders.values()].map((o) => ({ ...o }));
    },
    async markFailed(id, rawStatus) {
      const order = orders.get(id);
      if (order?.status !== "pending") return false;
      order.status = "failed";
      order.rawStatus = rawStatus;
      return true;
    },
    async expirePending(before) {
      let count = 0;
      for (const order of orders.values())
        if (order.status === "pending" && order.createdAt < before) {
          order.status = "expired";
          count += 1;
        }
      return count;
    },
    async markPaid(input) {
      const order = orders.get(input.orderId);
      if (!order || !["pending", "expired"].includes(order.status)) return null;
      Object.assign(order, {
        status: "paid",
        paymentKey: input.paymentKey,
        method: input.method,
        rawStatus: input.rawStatus,
        paidAt: input.now,
      });
      const validUntil = extendEntitlement(
        entitlements.get(order.userId)?.validUntil,
        input.periodDays,
        input.now,
      );
      entitlements.set(order.userId, {
        userId: order.userId,
        planId: order.planId,
        validUntil,
        lastOrderId: order.orderId,
      });
      return validUntil;
    },
    async markCanceled(input) {
      const order = orders.get(input.orderId);
      if (order?.status !== "paid") return false;
      Object.assign(order, {
        status: "canceled",
        canceledAt: input.now,
        cancelReason: input.reason,
        rawStatus: input.rawStatus,
      });
      const current = entitlements.get(order.userId);
      if (current) {
        const next = shortenEntitlement(
          current.validUntil,
          input.periodDays,
          input.now,
        );
        if (next) current.validUntil = next;
        else entitlements.delete(order.userId);
      }
      return true;
    },
    async entitlement(userId) {
      return entitlements.get(userId) ?? null;
    },
  };
  return { store, orders, entitlements };
}

function fakeToss() {
  const calls: string[] = [];
  const state: { payments: Map<string, TossPayment>; confirmError?: Error } = {
    payments: new Map(),
  };
  const toss: TossClient = {
    async confirm({ paymentKey, orderId, amount }) {
      calls.push(`confirm:${paymentKey}:${orderId}:${amount}`);
      if (state.confirmError) throw state.confirmError;
      const payment = {
        paymentKey,
        orderId,
        status: "DONE",
        totalAmount: amount,
        method: "카드",
      };
      state.payments.set(paymentKey, payment);
      return payment;
    },
    async getPayment(paymentKey) {
      calls.push(`get:${paymentKey}`);
      const payment = state.payments.get(paymentKey);
      if (!payment) throw new TossApiError(404, "NOT_FOUND_PAYMENT", "없음");
      return payment;
    },
    async cancel(paymentKey, reason) {
      calls.push(`cancel:${paymentKey}:${reason}`);
      const payment = state.payments.get(paymentKey)!;
      payment.status = "CANCELED";
      return payment;
    },
  };
  return { toss, calls, state };
}

function harness(role: "USER" | "SUPERADMIN" = "SUPERADMIN") {
  let now = new Date("2026-10-26T00:00:00Z");
  const clock = () => now;
  const { store, orders, entitlements } = fakeStore();
  const { toss, calls, state } = fakeToss();
  const service = new BillingService({
    store,
    toss,
    plans: PLANS,
    secret: SECRET,
    now: clock,
  });
  const sessions = new Map<string, { userId: string; expiresAt: Date }>();
  const accounts = new Map<
    string,
    { username: string; displayName: string | null }
  >();
  const portal = new WebPortal(
    {
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
      async learnerSubscription() {
        return null;
      },
    },
    {} as never,
    { list: async () => [], get: async () => null },
    {
      baseUrl: "https://rapi.example.com/",
      clientId: "999",
      clientSecret: "client-secret",
      secret: SECRET,
      allowlists:
        role === "SUPERADMIN"
          ? { userIds: [], superadminUserIds: [USER] }
          : { userIds: [], adminUserIds: [USER] },
      learnerEnabled: true,
      emailEnabled: false,
      fetch: (async (input: Request | string | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        return url.endsWith("/oauth2/token")
          ? Response.json({ access_token: "tok" })
          : Response.json({
              id: USER,
              username: "tester",
              global_name: "테스터",
            });
      }) as typeof fetch,
      now: clock,
      billing: {
        status: async (userId) => {
          const entitlement = await service.entitlement(userId);
          return entitlement
            ? {
                planName: service.planName(entitlement.planId),
                validUntil: entitlement.validUntil,
              }
            : null;
        },
      },
      routes: webBillingRoutes({
        service,
        baseUrl: "https://rapi.example.com",
        clientKey: "test_gck_docs_x",
        live: false,
      }),
      nav: WEB_BILLING_NAV,
    },
  );
  const request = (
    method: string,
    target: string,
    options: {
      cookie?: string;
      form?: Record<string, string>;
      body?: string;
    } = {},
  ): WebRequest => {
    const url = new URL(target, "http://local");
    return {
      method,
      path: url.pathname,
      query: url.searchParams,
      cookie: options.cookie,
      form: new URLSearchParams(options.form),
      body: options.body,
    };
  };
  const cookiesOf = (response: WebResponse): string[] => {
    const raw = response.headers["set-cookie"];
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
  };
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
    return { cookie, csrf };
  }
  /** Starts a checkout and returns the new order. */
  async function checkout(cookie: string, query = "plan=supporter") {
    const page = await portal.handle(
      request("GET", `/billing/checkout?${query}`, { cookie }),
    );
    const order = [...orders.values()].at(-1);
    return { page: page!, order: order! };
  }
  return {
    portal,
    service,
    request,
    login,
    checkout,
    orders,
    entitlements,
    calls,
    state,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    clock,
  };
}

const BILLING_REQUESTS: Array<[string, string]> = [
  ["GET", "/billing"],
  ["GET", "/billing/checkout?plan=supporter"],
  ["GET", "/billing/success?paymentKey=k&orderId=rapi_abc123&amount=1000"],
  ["GET", "/billing/fail?code=X&orderId=rapi_abc123"],
  ["POST", "/billing/webhook/toss"],
  ["GET", "/admin/billing"],
  ["POST", "/admin/billing"],
];

test("billing off: every billing route answers 404 and /me shows no plan", async () => {
  const off = new WebPortal(
    {
      async upsertAccount(input) {
        return input;
      },
      async createSession() {},
      async sessionAccount() {
        return { userId: USER, username: "t", displayName: null };
      },
      async deleteSession() {},
      async learnerSubscription() {
        return null;
      },
    },
    {} as never,
    { list: async () => [], get: async () => null },
    {
      baseUrl: "https://rapi.example.com",
      clientId: "999",
      clientSecret: "x",
      secret: SECRET,
      allowlists: { userIds: [], superadminUserIds: [USER] },
      learnerEnabled: true,
      emailEnabled: false,
    },
  );
  for (const [method, target] of BILLING_REQUESTS) {
    const url = new URL(target, "http://local");
    const reply = await off.handle({
      method,
      path: url.pathname,
      query: url.searchParams,
      form: new URLSearchParams(),
      body: "{}",
    });
    assert.equal(reply?.status, 404, `${method} ${target}`);
  }

  // createWebPortal mounts nothing for billing unless the flag is on and extras are given.
  const base = {
    RAPI_ENV: "test",
    DATABASE_URL: "postgresql://rapi:rapi@localhost:5432/rapi",
    DISCORD_BOT_TOKEN: "t",
    DISCORD_APPLICATION_ID: "1234567890",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    DISCORD_ALLOWED_USER_IDS: "100",
    DISCORD_OAUTH_CLIENT_ID: "999",
    DISCORD_OAUTH_CLIENT_SECRET: "secret",
    RAPI_PUBLIC_BASE_URL: "https://rapi.example.com",
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    WEB_ENABLED: "true",
  };
  const config = loadEnvironment(base);
  assert.equal(config.BILLING_ENABLED, false);
  const portal = createWebPortal(
    config,
    { userIds: [] },
    { sessionAccount: async () => null } as never,
    {} as never,
  );
  const reply = await portal!.handle({
    method: "GET",
    path: "/billing",
    query: new URLSearchParams(),
    form: new URLSearchParams(),
  });
  assert.equal(reply?.status, 404);

  // Even without the web portal the bot never hands a billing POST to the interaction handler.
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
    for (const [method, target] of BILLING_REQUESTS.slice(0, 5))
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${address.port}${target}`, {
            method,
            ...(method === "POST" ? { body: "{}" } : {}),
          })
        ).status,
        404,
        target,
      );
  } finally {
    bot.close();
  }
});

test("/me shows the plan line only when billing is on", async () => {
  const h = harness();
  const { cookie } = await h.login();
  let me = await h.portal.handle(h.request("GET", "/me", { cookie }));
  assert.match(me!.body, /요금제: 무료/);
  const { order } = await h.checkout(cookie);
  await h.portal.handle(
    h.request(
      "GET",
      `/billing/success?paymentKey=pk_1&orderId=${order.orderId}&amount=1000`,
      { cookie },
    ),
  );
  me = await h.portal.handle(h.request("GET", "/me", { cookie }));
  assert.match(me!.body, /요금제: 서포터 \(2026-11-25까지\)/);
});

test("config: billing needs its flags, and live keys are refused without BILLING_LIVE", () => {
  const base = {
    RAPI_ENV: "test",
    DATABASE_URL: "postgresql://rapi:rapi@localhost:5432/rapi",
    DISCORD_BOT_TOKEN: "t",
    DISCORD_APPLICATION_ID: "1234567890",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    DISCORD_ALLOWED_USER_IDS: "100",
    DISCORD_OAUTH_CLIENT_ID: "999",
    DISCORD_OAUTH_CLIENT_SECRET: "secret",
    RAPI_PUBLIC_BASE_URL: "https://rapi.example.com",
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    WEB_ENABLED: "true",
  };
  const keys = {
    TOSS_CLIENT_KEY: "test_gck_docs_x",
    TOSS_SECRET_KEY: "test_gsk_docs_x",
  };
  assert.equal(loadEnvironment(base).BILLING_ENABLED, false);
  assert.throws(
    () => loadEnvironment({ ...base, BILLING_ENABLED: "true" }),
    /BILLING_ENABLED requires .*TOSS_CLIENT_KEY.*TOSS_SECRET_KEY/,
  );
  assert.throws(
    () =>
      loadEnvironment({
        ...base,
        ...keys,
        BILLING_ENABLED: "true",
        WEB_ENABLED: "false",
      }),
    /BILLING_ENABLED requires WEB_ENABLED/,
  );
  assert.throws(
    () =>
      loadEnvironment({
        ...base,
        ...keys,
        BILLING_ENABLED: "true",
        RAPI_PUBLIC_BASE_URL: undefined,
        WEBHOOK_ENCRYPTION_KEY: undefined,
      }),
    /BILLING_ENABLED requires .*RAPI_PUBLIC_BASE_URL/,
  );
  assert.equal(
    loadEnvironment({ ...base, ...keys, BILLING_ENABLED: "true" })
      .BILLING_ENABLED,
    true,
  );
  assert.throws(
    () =>
      loadEnvironment({
        ...base,
        ...keys,
        TOSS_SECRET_KEY: "live_sk_real",
        BILLING_ENABLED: "true",
      }),
    /TOSS_SECRET_KEY must start with test_ unless BILLING_LIVE=true/,
  );
  assert.throws(
    () =>
      loadEnvironment({
        ...base,
        ...keys,
        TOSS_CLIENT_KEY: "live_ck_real",
        BILLING_ENABLED: "true",
      }),
    /TOSS_CLIENT_KEY must start with test_/,
  );
  assert.equal(
    loadEnvironment({
      ...base,
      TOSS_CLIENT_KEY: "live_ck_real",
      TOSS_SECRET_KEY: "live_sk_real",
      BILLING_ENABLED: "true",
      BILLING_LIVE: "true",
    }).BILLING_LIVE,
    true,
  );
});

test("checkout creates a pending order with the plan's amount; the client cannot choose it", async () => {
  const h = harness();
  assert.equal(
    (
      await h.portal.handle(
        h.request("GET", "/billing/checkout?plan=supporter"),
      )
    )?.status,
    401,
  );
  assert.equal(h.orders.size, 0);
  const { cookie } = await h.login();
  const { page, order } = await h.checkout(
    cookie,
    "plan=supporter&amount=1&price=1&priceKrw=1",
  );
  assert.equal(page.status, 200);
  assert.equal(order.amountKrw, 1000);
  assert.equal(order.status, "pending");
  assert.equal(order.userId, USER);
  assert.ok(isBillingOrderId(order.orderId));
  assert.match(page.body, /테스트 결제/);
  assert.match(page.body, /renderPaymentMethods/);
  assert.match(page.body, /"amount":1000/);
  assert.match(page.body, /"customerKey":"rc_/);
  assert.equal(page.body.includes(USER), false);
  assert.match(
    page.body,
    /"successUrl":"https:\/\/rapi\.example\.com\/billing\/success"/,
  );
  assert.equal((await h.checkout(cookie, "plan=nope")).page.status, 404);
  assert.equal((await h.checkout(cookie, "plan=soon")).page.status, 409);
  assert.equal(h.orders.size, 1);
});

test("checkout CSP lists the Toss origins; every other page keeps the strict CSP", async () => {
  const h = harness();
  const { cookie } = await h.login();
  const { page } = await h.checkout(cookie);
  const csp = String(page.headers["content-security-policy"]);
  const nonce = /<script nonce="([^"]+)"/.exec(page.body)![1]!;
  assert.match(csp, /^default-src 'none'/);
  assert.ok(
    csp.includes(`script-src 'nonce-${nonce}' https://js.tosspayments.com`),
  );
  // The widget frames card-issuer and easy-pay pages on many https origins and
  // posts forms to them; this was found by a real test payment.
  assert.ok(csp.includes("frame-src https:"));
  assert.ok(csp.includes("form-action 'self' https:"));
  assert.ok(csp.includes("style-src 'unsafe-inline' https:"));
  assert.ok(csp.includes("connect-src https://*.tosspayments.com"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.equal(
    page.headers["referrer-policy"],
    "strict-origin-when-cross-origin",
  );
  assert.match(
    page.body,
    /<script src="https:\/\/js\.tosspayments\.com\/v2\/standard">/,
  );
  const strict =
    /^default-src 'none'; style-src 'nonce-[^']+'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/;
  for (const target of ["/billing", "/me", "/archive", "/admin/billing"]) {
    const reply = await h.portal.handle(h.request("GET", target, { cookie }));
    assert.match(
      String(reply!.headers["content-security-policy"]),
      strict,
      target,
    );
    assert.equal(reply!.body.includes("<script"), false, target);
  }
});

test("billing list is public, shows prices, and marks a zero-price plan as 준비 중", async () => {
  const h = harness();
  const reply = await h.portal.handle(h.request("GET", "/billing"));
  assert.equal(reply!.status, 200);
  assert.match(reply!.body, /noindex/);
  assert.match(reply!.body, /1,000원/);
  assert.match(reply!.body, /30일 이용권/);
  assert.match(reply!.body, /준비 중/);
  assert.equal(reply!.body.includes("/billing/checkout?plan=soon"), false);
});

test("success with a tampered amount makes no confirm call and fails the order", async () => {
  const h = harness();
  const { cookie } = await h.login();
  const { order } = await h.checkout(cookie);
  const reply = await h.portal.handle(
    h.request(
      "GET",
      `/billing/success?paymentKey=pk_1&orderId=${order.orderId}&amount=10`,
      { cookie },
    ),
  );
  assert.equal(reply!.status, 400);
  assert.deepEqual(h.calls, []);
  assert.equal(h.orders.get(order.orderId)!.status, "failed");
  assert.equal(h.entitlements.size, 0);
  // The failed order cannot be confirmed afterwards, even with the right amount.
  const again = await h.portal.handle(
    h.request(
      "GET",
      `/billing/success?paymentKey=pk_1&orderId=${order.orderId}&amount=1000`,
      { cookie },
    ),
  );
  assert.equal(again!.status, 409);
  assert.deepEqual(h.calls, []);
});

test("success twice confirms once and gives the same result", async () => {
  const h = harness();
  const { cookie } = await h.login();
  const { order } = await h.checkout(cookie);
  const url = `/billing/success?paymentKey=pk_1&orderId=${order.orderId}&amount=1000`;
  const first = await h.portal.handle(h.request("GET", url, { cookie }));
  const second = await h.portal.handle(h.request("GET", url, { cookie }));
  assert.equal(first!.status, 200);
  assert.equal(second!.status, 200);
  assert.match(first!.body, /2026-11-25까지/);
  assert.match(second!.body, /2026-11-25까지/);
  assert.equal(h.calls.filter((call) => call.startsWith("confirm")).length, 1);
  assert.deepEqual(h.calls, [`confirm:pk_1:${order.orderId}:1000`]);
  assert.equal(h.orders.get(order.orderId)!.status, "paid");
  assert.equal(
    h.entitlements.get(USER)!.validUntil.getTime(),
    new Date("2026-10-26T00:00:00Z").getTime() + 30 * DAY,
  );
});

test("success refuses an order of another user and bad parameters", async () => {
  const h = harness();
  const { cookie } = await h.login();
  await h.service.checkout("999999999999999999", "supporter");
  const foreign = [...h.orders.values()][0]!;
  const reply = await h.portal.handle(
    h.request(
      "GET",
      `/billing/success?paymentKey=pk_1&orderId=${foreign.orderId}&amount=1000`,
      { cookie },
    ),
  );
  assert.equal(reply!.status, 404);
  for (const query of [
    "paymentKey=pk_1&orderId=x&amount=1000",
    `paymentKey=pk_1&orderId=${foreign.orderId}&amount=-1`,
    `paymentKey=&orderId=${foreign.orderId}&amount=1000`,
    "",
  ])
    assert.equal(
      (await h.portal.handle(
        h.request("GET", `/billing/success?${query}`, { cookie }),
      ))!.status,
      400,
      query,
    );
  assert.deepEqual(h.calls, []);
});

test("an uncertain confirm leaves the order pending; a Toss rejection fails it", async () => {
  const h = harness();
  const { cookie } = await h.login();
  const { order } = await h.checkout(cookie);
  h.state.confirmError = new TossUncertainError();
  const url = `/billing/success?paymentKey=pk_1&orderId=${order.orderId}&amount=1000`;
  const waiting = await h.portal.handle(h.request("GET", url, { cookie }));
  assert.equal(waiting!.status, 202);
  assert.equal(h.orders.get(order.orderId)!.status, "pending");
  h.state.confirmError = new TossApiError(
    400,
    "REJECT_CARD_PAYMENT",
    "한도 초과",
  );
  const failed = await h.portal.handle(h.request("GET", url, { cookie }));
  assert.equal(failed!.status, 402);
  assert.equal(h.orders.get(order.orderId)!.status, "failed");
});

test("fail marks only the caller's pending order failed and offers a retry", async () => {
  const h = harness();
  const { cookie } = await h.login();
  const { order } = await h.checkout(cookie);
  const reply = await h.portal.handle(
    h.request(
      "GET",
      `/billing/fail?code=PAY_PROCESS_CANCELED&message=${encodeURIComponent("<b>취소</b>")}&orderId=${order.orderId}`,
      { cookie },
    ),
  );
  assert.equal(reply!.status, 200);
  assert.match(reply!.body, /\/billing"/);
  assert.equal(reply!.body.includes("<b>취소</b>"), false);
  assert.equal(h.orders.get(order.orderId)!.status, "failed");
  assert.equal(h.orders.get(order.orderId)!.rawStatus, "PAY_PROCESS_CANCELED");
  await h.service.checkout("999999999999999999", "supporter");
  const foreign = [...h.orders.values()].at(-1)!;
  await h.portal.handle(
    h.request("GET", `/billing/fail?code=X&orderId=${foreign.orderId}`, {
      cookie,
    }),
  );
  assert.equal(h.orders.get(foreign.orderId)!.status, "pending");
});

test("webhook re-queries Toss and only that answer changes state", async () => {
  const h = harness();
  const { cookie } = await h.login();
  const { order } = await h.checkout(cookie);
  const hook = (body: string) =>
    h.portal.handle(h.request("POST", "/billing/webhook/toss", { body }));
  // The body claims DONE, but Toss says the payment is still not paid.
  h.state.payments.set("pk_9", {
    paymentKey: "pk_9",
    orderId: order.orderId,
    status: "WAITING_FOR_DEPOSIT",
    totalAmount: 1000,
    method: "가상계좌",
  });
  let reply = await hook(
    JSON.stringify({
      eventType: "PAYMENT_STATUS_CHANGED",
      data: { paymentKey: "pk_9", orderId: order.orderId, status: "DONE" },
    }),
  );
  assert.equal(reply!.status, 200);
  assert.deepEqual(h.calls, ["get:pk_9"]);
  assert.equal(h.orders.get(order.orderId)!.status, "pending");
  // Toss now reports DONE with a different amount: ignored.
  h.state.payments.get("pk_9")!.status = "DONE";
  h.state.payments.get("pk_9")!.totalAmount = 5;
  await hook(JSON.stringify({ data: { paymentKey: "pk_9" } }));
  assert.equal(h.orders.get(order.orderId)!.status, "pending");
  // Toss reports DONE with the right amount: paid and entitled.
  h.state.payments.get("pk_9")!.totalAmount = 1000;
  reply = await hook(JSON.stringify({ data: { paymentKey: "pk_9" } }));
  assert.equal(reply!.status, 200);
  assert.equal(h.orders.get(order.orderId)!.status, "paid");
  assert.equal(h.orders.get(order.orderId)!.paymentKey, "pk_9");
  assert.ok(h.entitlements.get(USER));
  // A repeated delivery changes nothing.
  const until = h.entitlements.get(USER)!.validUntil.getTime();
  await hook(JSON.stringify({ data: { paymentKey: "pk_9" } }));
  assert.equal(h.entitlements.get(USER)!.validUntil.getTime(), until);
  // Toss reports CANCELED: order canceled and entitlement removed.
  h.state.payments.get("pk_9")!.status = "CANCELED";
  await hook(JSON.stringify({ data: { paymentKey: "pk_9" } }));
  assert.equal(h.orders.get(order.orderId)!.status, "canceled");
  assert.equal(h.entitlements.size, 0);
});

test("webhook answers 200 for unknown payments and junk, 400 for non-JSON, 503 when Toss fails", async () => {
  const h = harness();
  const hook = (body: string) =>
    h.portal.handle(h.request("POST", "/billing/webhook/toss", { body }));
  h.state.payments.set("pk_x", {
    paymentKey: "pk_x",
    orderId: "rapi_unknown_order",
    status: "DONE",
    totalAmount: 1000,
    method: null,
  });
  assert.equal(
    (await hook(JSON.stringify({ data: { paymentKey: "pk_x" } })))!.status,
    200,
  );
  assert.equal(h.orders.size, 0);
  assert.equal((await hook("{}"))!.status, 200);
  assert.equal(
    (await hook(JSON.stringify({ data: { paymentKey: 7 } })))!.status,
    200,
  );
  assert.equal(
    (await hook(JSON.stringify({ data: { paymentKey: "../x" } })))!.status,
    200,
  );
  assert.deepEqual(h.calls, ["get:pk_x"]);
  assert.equal((await hook("not json"))!.status, 400);
  assert.equal(
    (await hook(JSON.stringify({ data: { paymentKey: "pk_missing" } })))!
      .status,
    503,
  );
});

test("refund calls Toss cancel after a confirm step and removes the entitlement", async () => {
  const h = harness();
  const { cookie, csrf } = await h.login();
  const { order } = await h.checkout(cookie);
  await h.portal.handle(
    h.request(
      "GET",
      `/billing/success?paymentKey=pk_1&orderId=${order.orderId}&amount=1000`,
      { cookie },
    ),
  );
  const listing = await h.portal.handle(
    h.request("GET", "/admin/billing", { cookie }),
  );
  assert.match(listing!.body, /환불/);
  assert.match(listing!.body, new RegExp(order.orderId));
  const form = { csrf, orderId: order.orderId, action: "refund" };
  const confirmStep = await h.portal.handle(
    h.request("POST", "/admin/billing", { cookie, form }),
  );
  assert.match(confirmStep!.body, /환불할까요/);
  assert.equal(
    h.calls.some((call) => call.startsWith("cancel")),
    false,
  );
  const bad = await h.portal.handle(
    h.request("POST", "/admin/billing", {
      cookie,
      form: { ...form, confirm: "1", csrf: "wrong" },
    }),
  );
  assert.equal(bad!.status, 403);
  assert.equal(
    h.calls.some((call) => call.startsWith("cancel")),
    false,
  );
  const done = await h.portal.handle(
    h.request("POST", "/admin/billing", {
      cookie,
      form: { ...form, confirm: "1" },
    }),
  );
  assert.match(done!.body, /환불했어요/);
  assert.equal(h.calls.filter((call) => call.startsWith("cancel")).length, 1);
  assert.equal(h.orders.get(order.orderId)!.status, "canceled");
  assert.equal(h.entitlements.size, 0);
  // Refunding again does nothing at Toss.
  const twice = await h.portal.handle(
    h.request("POST", "/admin/billing", {
      cookie,
      form: { ...form, confirm: "1" },
    }),
  );
  assert.match(twice!.body, /결제 완료 상태의 주문만/);
  assert.equal(h.calls.filter((call) => call.startsWith("cancel")).length, 1);
});

test("refund is SUPERADMIN only", async () => {
  const h = harness("USER");
  const { cookie, csrf } = await h.login();
  for (const reply of [
    await h.portal.handle(h.request("GET", "/admin/billing", { cookie })),
    await h.portal.handle(
      h.request("POST", "/admin/billing", {
        cookie,
        form: { csrf, orderId: "rapi_abc123", action: "refund", confirm: "1" },
      }),
    ),
  ])
    assert.equal(reply!.status, 403);
  assert.deepEqual(h.calls, []);
});

test("refunding the first of two purchases only shortens the entitlement", async () => {
  const h = harness();
  const { cookie } = await h.login();
  for (const key of ["pk_a", "pk_b"]) {
    const { order } = await h.checkout(cookie);
    await h.portal.handle(
      h.request(
        "GET",
        `/billing/success?paymentKey=${key}&orderId=${order.orderId}&amount=1000`,
        { cookie },
      ),
    );
  }
  assert.equal(
    h.entitlements.get(USER)!.validUntil.getTime(),
    new Date("2026-10-26T00:00:00Z").getTime() + 60 * DAY,
  );
  const first = [...h.orders.values()][0]!;
  assert.equal(
    (await h.service.refund(first.orderId, "테스트")).kind,
    "refunded",
  );
  assert.equal(
    h.entitlements.get(USER)!.validUntil.getTime(),
    new Date("2026-10-26T00:00:00Z").getTime() + 30 * DAY,
  );
});

test("entitlements extend from max(now, valid_until) and refunds take the period back", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  const iso = (date: Date | null) => date?.toISOString();
  assert.equal(
    iso(extendEntitlement(undefined, 30, now)),
    "2026-11-25T00:00:00.000Z",
  );
  // Expired long ago: counted from now.
  assert.equal(
    iso(extendEntitlement(new Date("2026-01-01T00:00:00Z"), 30, now)),
    "2026-11-25T00:00:00.000Z",
  );
  // Still valid: counted from the end.
  assert.equal(
    iso(extendEntitlement(new Date("2026-11-05T00:00:00Z"), 30, now)),
    "2026-12-05T00:00:00.000Z",
  );
  assert.equal(
    iso(shortenEntitlement(new Date("2026-12-05T00:00:00Z"), 30, now)),
    "2026-11-05T00:00:00.000Z",
  );
  assert.equal(
    shortenEntitlement(new Date("2026-11-05T00:00:00Z"), 30, now),
    null,
  );
});

test("allowsFeature passes for everyone while billing is off", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  const live = {
    planId: "supporter",
    validUntil: new Date(now.getTime() + DAY),
    features: ["pro"],
  };
  assert.equal(allowsFeature(undefined, "pro", false, now), true);
  assert.equal(allowsFeature(undefined, "pro", true, now), false);
  assert.equal(allowsFeature(live, "pro", true, now), true);
  assert.equal(allowsFeature(live, "other", true, now), false);
  assert.equal(
    allowsFeature(
      { ...live, validUntil: new Date(now.getTime() - 1) },
      "pro",
      true,
      now,
    ),
    false,
  );
});

test("order ids, customer keys and plans", async () => {
  const id = newBillingOrderId();
  assert.ok(isBillingOrderId(id), id);
  assert.notEqual(id, newBillingOrderId());
  for (const bad of ["abc", "a b c d e f", "x".repeat(65), "한글한글한글"])
    assert.equal(isBillingOrderId(bad), false);
  const key = billingCustomerKey(SECRET, USER);
  assert.match(key, /^rc_[\w-]{32}$/);
  assert.equal(key.includes(USER), false);
  assert.notEqual(key, billingCustomerKey(SECRET, "223456789012345678"));
  assert.equal(planPurchasable(PLANS[1]!), false);
  const shipped = await loadBillingPlans();
  assert.equal(shipped[0]!.id, "supporter");
  assert.equal(shipped[0]!.priceKrw, 1000);
  assert.equal(shipped[0]!.periodDays, 30);
  assert.deepEqual(shipped[0]!.features, []);
  assert.match(
    await readFile("ops/billing-plans.json", "utf8"),
    /"_note": ".*placeholder/,
  );
  assert.throws(() => parseBillingPlans('{"plans":[{"id":"A b"}]}'));
  assert.throws(() =>
    parseBillingPlans(JSON.stringify({ plans: [PLANS[0], PLANS[0]] })),
  );
});

test("Toss client: auth, idempotency, one idempotent retry on network error, no secret in errors", async () => {
  const secret = "test_gsk_docs_SECRET";
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let failures = 1;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : input.toString();
    seen.push({ url, init: init! });
    if (url.endsWith("/confirm") && failures-- > 0)
      throw new Error(`socket hang up (${secret})`);
    if (url.includes("/pk_bad"))
      return Response.json(
        { code: "NOT_FOUND_PAYMENT", message: "없는 결제" },
        { status: 404 },
      );
    if (url.includes("/pk_500")) return new Response("oops", { status: 502 });
    return Response.json({
      paymentKey: "pk_1",
      orderId: "rapi_abc123",
      status: "DONE",
      totalAmount: 1000,
      method: "카드",
    });
  }) as typeof fetch;
  const client = createTossClient({ secretKey: secret, fetch: fetcher });
  const payment = await client.confirm({
    paymentKey: "pk_1",
    orderId: "rapi_abc123",
    amount: 1000,
  });
  assert.equal(payment.status, "DONE");
  assert.equal(seen.length, 2);
  for (const call of seen) {
    const headers = call.init.headers as Record<string, string>;
    assert.equal(call.url, "https://api.tosspayments.com/v1/payments/confirm");
    assert.equal(
      headers.authorization,
      `Basic ${Buffer.from(`${secret}:`).toString("base64")}`,
    );
    assert.equal(headers["idempotency-key"], "rapi-confirm-rapi_abc123");
    assert.deepEqual(JSON.parse(call.init.body as string), {
      paymentKey: "pk_1",
      orderId: "rapi_abc123",
      amount: 1000,
    });
  }
  // A second network failure is "uncertain", and nothing leaks the key.
  failures = 2;
  await assert.rejects(
    client.confirm({
      paymentKey: "pk_1",
      orderId: "rapi_abc123",
      amount: 1000,
    }),
    (error: Error) =>
      error instanceof TossUncertainError && !error.message.includes(secret),
  );
  await client.getPayment("pk_1");
  assert.equal(
    seen.at(-1)!.url,
    "https://api.tosspayments.com/v1/payments/pk_1",
  );
  assert.equal(seen.at(-1)!.init.method, "GET");
  await assert.rejects(
    client.getPayment("pk_bad"),
    (error: Error) =>
      error instanceof TossApiError &&
      error.code === "NOT_FOUND_PAYMENT" &&
      !error.message.includes(secret),
  );
  await assert.rejects(client.getPayment("pk_500"), TossUncertainError);
  await client.cancel("pk_1", "환불");
  const cancel = seen.at(-1)!;
  assert.equal(
    cancel.url,
    "https://api.tosspayments.com/v1/payments/pk_1/cancel",
  );
  assert.equal(
    (cancel.init.headers as Record<string, string>)["idempotency-key"],
    "rapi-cancel-pk_1",
  );
  assert.deepEqual(JSON.parse(cancel.init.body as string), {
    cancelReason: "환불",
  });
});

test("privacy deletion removes entitlements and pseudonymizes orders instead of deleting them", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  await deleteUserBilling(client as never, USER, "hmac:v1:abc");
  assert.ok(
    queries.some(
      (q) =>
        /DELETE FROM billing_entitlements WHERE user_id=\$1/.test(q.sql) &&
        q.params[0] === USER,
    ),
  );
  assert.ok(
    queries.some(
      (q) =>
        /UPDATE billing_orders SET user_id=\$2 WHERE user_id=\$1/.test(q.sql) &&
        q.params[1] === "hmac:v1:abc",
    ),
  );
  assert.equal(
    queries.some((q) => /DELETE FROM billing_orders/.test(q.sql)),
    false,
  );
});
