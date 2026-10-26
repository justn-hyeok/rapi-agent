import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";
import {
  EmailDeliveryAdapter,
  MemoryEmailTransport,
  PermanentDeliveryError,
  PostmarkEmailTransport,
  ResendEmailTransport,
} from "@rapi/adapters";
import {
  EmailService,
  DiscordCommandService,
  LearnerExperiment,
  type RapiAgent,
  createEmailService,
} from "@rapi/agent";
import { loadEnvironment } from "@rapi/config";
import {
  emailTokenKey,
  escapeHtml,
  parseEmailAddress,
  parseEmailWebhook,
  renderLearnerIssueEmail,
  signEmailToken,
  verifyEmailToken,
  verifyPostmarkWebhook,
  verifyResendWebhook,
} from "@rapi/core";
import {
  deleteUserEmails,
  expireEmails,
} from "../scripts/privacy-lifecycle.mjs";

const key = emailTokenKey("k".repeat(32));
const id = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-26T00:00:00Z");

test("email tokens verify only for their purpose, key and lifetime", () => {
  const token = signEmailToken(key, "verify", id, now);
  assert.deepEqual(verifyEmailToken(key, "verify", token, now), {
    addressId: id,
  });
  assert.equal(verifyEmailToken(key, "unsub", token, now), null);
  assert.equal(
    verifyEmailToken(emailTokenKey("j".repeat(32)), "verify", token, now),
    null,
  );
  assert.equal(
    verifyEmailToken(
      key,
      "verify",
      token,
      new Date(now.getTime() + 25 * 3600_000),
    ),
    null,
  );
  assert.deepEqual(
    verifyEmailToken(
      key,
      "verify",
      token,
      new Date(now.getTime() + 23 * 3600_000),
    ),
    { addressId: id },
  );
  const [, expires, sig] = token.split(".");
  assert.equal(
    verifyEmailToken(
      key,
      "verify",
      `22222222-2222-4222-8222-222222222222.${expires}.${sig}`,
      now,
    ),
    null,
  );
  assert.equal(verifyEmailToken(key, "verify", `${token}x`, now), null);
  // Unsubscribe links outlive the verification window.
  const unsub = signEmailToken(key, "unsub", id, now);
  assert.ok(
    verifyEmailToken(key, "unsub", unsub, new Date("2027-10-26T00:00:00Z")),
  );
  assert.ok(!token.includes("@"));
});

test("addresses are validated and normalised", () => {
  assert.equal(parseEmailAddress(" A.b@Example.COM "), "A.b@example.com");
  for (const bad of [
    "a@b",
    "a b@example.com",
    "a@example.com\r\nBcc: x@y.zz",
    "<a@example.com>",
    "a..b@example.com",
    "한글@example.com",
    "a@example.com, b@example.com",
  ])
    assert.equal(parseEmailAddress(bad), null, bad);
});

test("issue email escapes HTML and carries the unsubscribe footer", () => {
  const mail = renderLearnerIssueEmail({
    periodKey: "2026-10-26",
    cadenceLabel: "매일",
    unsubscribeUrl: "https://rapi.example/e/unsub/t?a=1&b=2",
    items: [
      {
        section: "core",
        title: '<script>alert("x")</script>',
        summary: "a & b",
        link: "https://rapi.example/r/t",
      },
    ],
  });
  assert.ok(!mail.html.includes("<script>"));
  assert.ok(mail.html.includes("&lt;script&gt;"));
  assert.ok(mail.html.includes("a &amp; b"));
  assert.ok(mail.html.includes("a=1&amp;b=2"));
  assert.ok(
    mail.text.includes("메일 그만 받기: https://rapi.example/e/unsub/"),
  );
  assert.equal(escapeHtml(`"'<>&`), "&quot;&#39;&lt;&gt;&amp;");
  assert.equal(
    mail.headers["List-Unsubscribe"],
    "<https://rapi.example/e/unsub/t?a=1&b=2>",
  );
  assert.equal(
    mail.headers["List-Unsubscribe-Post"],
    "List-Unsubscribe=One-Click",
  );
});

interface Row {
  id: string;
  userId: string;
  email: string;
  verified: boolean;
  unsubscribed: boolean;
  bounceState: "none" | "soft" | "hard" | "complaint";
  soft: number;
  sentAt?: number;
}

function fakeEmailStore() {
  const rows: Row[] = [];
  const deliveries: Array<{ issueId: string; emailId: string; state: string }> =
    [];
  let counter = 0;
  const view = (row: Row) => ({
    id: row.id,
    userId: row.userId,
    email: row.email,
    verified: row.verified,
    unsubscribed: row.unsubscribed,
    bounceState: row.bounceState,
  });
  return {
    rows,
    deliveries,
    async register(userId: string, email: string) {
      let row = rows.find((r) => r.userId === userId);
      if (!row || row.email.toLowerCase() !== email.toLowerCase()) {
        const created: Row = {
          id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
          userId,
          email,
          verified: false,
          unsubscribed: false,
          bounceState: "none",
          soft: 0,
        };
        if (row) rows.splice(rows.indexOf(row), 1);
        rows.push(created);
        row = created;
      }
      row.unsubscribed = false;
      return view(row);
    },
    async claimVerificationSend(rowId: string, at: Date, cooldownMs: number) {
      const row = rows.find((r) => r.id === rowId)!;
      if (row.sentAt !== undefined && row.sentAt > at.getTime() - cooldownMs)
        return false;
      row.sentAt = at.getTime();
      return true;
    },
    async byId(rowId: string) {
      const row = rows.find((r) => r.id === rowId);
      return row ? view(row) : null;
    },
    async verify(rowId: string) {
      const row = rows.find((r) => r.id === rowId);
      if (!row) return "missing" as const;
      if (row.verified) return "already" as const;
      row.verified = true;
      return "verified" as const;
    },
    async unsubscribe(rowId: string) {
      const row = rows.find((r) => r.id === rowId);
      if (row) row.unsubscribed = true;
      return !!row;
    },
    async suppress(email: string, kind: "hard" | "soft" | "complaint") {
      let n = 0;
      for (const row of rows)
        if (row.email.toLowerCase() === email.toLowerCase()) {
          n += 1;
          if (kind === "soft") row.soft += 1;
          else row.bounceState = kind === "hard" ? "hard" : "complaint";
        }
      return n;
    },
    async recipients(_cadence: "daily" | "weekly", issueId: string) {
      return rows
        .filter(
          (r) =>
            r.verified &&
            !r.unsubscribed &&
            ["none", "soft"].includes(r.bounceState) &&
            !deliveries.some(
              (d) => d.issueId === issueId && d.emailId === r.id,
            ),
        )
        .map((r) => ({ emailId: r.id, userId: r.userId, email: r.email }));
    },
    async claimDelivery(issueId: string, emailId: string) {
      if (
        deliveries.some((d) => d.issueId === issueId && d.emailId === emailId)
      )
        return false;
      deliveries.push({ issueId, emailId, state: "pending" });
      return true;
    },
    async finishDelivery(input: {
      issueId: string;
      emailId: string;
      state: string;
    }) {
      deliveries.find(
        (d) => d.issueId === input.issueId && d.emailId === input.emailId,
      )!.state = input.state;
    },
    async deliveryCounts(issueId: string) {
      const mine = deliveries.filter((d) => d.issueId === issueId);
      return {
        sent: mine.filter((d) => d.state === "sent").length,
        failed: mine.filter((d) => d.state === "failed").length,
      };
    },
  };
}

const whsec = `whsec_${Buffer.from("resend-signing-key").toString("base64")}`;

function emailSetup(provider: "resend" | "postmark" = "resend") {
  const store = fakeEmailStore();
  const transport = new MemoryEmailTransport();
  const service = new EmailService(
    store as never,
    new EmailDeliveryAdapter(transport, {
      from: "라피 <news@rapi.example>",
      replyTo: "help@rapi.example",
    }),
    {
      linkSecret: "k".repeat(32),
      baseUrl: "https://rapi.example",
      provider,
      webhookSecret: provider === "resend" ? whsec : "hook:pass",
      pauseMs: 0,
    },
  );
  return { store, transport, service };
}

const issue = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  cadence: "daily" as const,
  periodKey: "2026-10-26",
  items: [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      section: "core" as const,
      title: "제목 <b>굵게</b>",
      summary: "요약",
      url: "https://original.example/post",
    },
  ],
};

function tokenFrom(text: string, kind: string): string {
  const match = new RegExp(`/e/${kind}/([\\w.-]+)`).exec(text);
  assert.ok(match, text);
  return match[1]!;
}

test("registration mails a verification link that works once, and only after a confirm POST", async () => {
  const { store, transport, service } = emailSetup();
  assert.match(await service.register("7", "not-an-address", now), /형식/);
  assert.equal(transport.messages.length, 0);
  const reply = await service.register("7", "Reader@Example.com", now);
  assert.match(reply, /확인 메일을 보냈어요/);
  assert.equal(transport.messages.length, 1);
  assert.equal(transport.messages[0]!.to, "Reader@example.com");
  // A second request inside the cooldown sends nothing.
  assert.match(await service.register("7", "Reader@Example.com", now), /방금/);
  assert.equal(transport.messages.length, 1);

  const token = tokenFrom(transport.messages[0]!.text, "verify");
  const preview = await service.verifyLink(token, "GET", now);
  assert.equal(preview.status, 200);
  assert.equal(store.rows[0]!.verified, false);
  const done = await service.verifyLink(token, "POST", now);
  assert.match(done.html, /확인했어요/);
  assert.equal(store.rows[0]!.verified, true);
  assert.match(
    (await service.verifyLink(token, "POST", now)).html,
    /이미 확인/,
  );
  const late = new Date(now.getTime() + 25 * 3600_000);
  assert.equal((await service.verifyLink(token, "GET", late)).status, 404);
  assert.equal((await service.unsubscribeLink(token, "GET", now)).status, 404);
});

async function verified(
  service: EmailService,
  store: ReturnType<typeof fakeEmailStore>,
  userId: string,
  address: string,
) {
  await service.register(userId, address, now);
  store.rows.find((r) => r.userId === userId)!.verified = true;
}

test("an issue is mailed to verified addresses with unsubscribe headers and tracked links", async () => {
  const { store, transport, service } = emailSetup();
  await verified(service, store, "7", "a@example.com");
  await service.register("8", "pending@example.com", now); // never confirmed
  transport.messages.length = 0;
  transport.failures.add("c@example.com");
  await verified(service, store, "9", "c@example.com");
  const counts = await service.sendIssue(issue, now);
  assert.deepEqual(counts, { sent: 1, failed: 1 });
  const message = transport.messages.find((m) => m.to === "a@example.com")!;
  assert.equal(message.from, "라피 <news@rapi.example>");
  assert.equal(message.replyTo, "help@rapi.example");
  assert.match(
    message.headers["List-Unsubscribe"]!,
    /^<https:\/\/rapi\.example\/e\/unsub\/[\w.-]+>$/,
  );
  assert.equal(
    message.headers["List-Unsubscribe-Post"],
    "List-Unsubscribe=One-Click",
  );
  assert.ok(message.html.includes("https://rapi.example/r/bbbbbbbb-"));
  assert.ok(!message.html.includes("original.example"));
  // Markup in a feed title is dropped, not shown as text.
  assert.ok(message.html.includes("제목 굵게"));
  assert.ok(!message.html.includes("&lt;b&gt;"));
  // A repeat send neither mails again nor retries the failure.
  await service.sendIssue(issue, now);
  assert.equal(
    transport.messages.filter((m) => m.to === "a@example.com").length,
    1,
  );
  assert.equal(store.deliveries.filter((d) => d.state === "failed").length, 1);
});

test("unsubscribing stops mail, by page or by one-click POST", async () => {
  const { store, transport, service } = emailSetup();
  await verified(service, store, "7", "a@example.com");
  transport.messages.length = 0;
  await service.sendIssue(issue, now);
  const token = tokenFrom(
    transport.messages[0]!.headers["List-Unsubscribe"]!,
    "unsub",
  );
  assert.equal(store.rows[0]!.unsubscribed, false);
  assert.equal((await service.unsubscribeLink(token, "GET", now)).status, 200);
  assert.equal(store.rows[0]!.unsubscribed, false);
  assert.equal((await service.unsubscribeLink(token, "POST", now)).status, 200);
  assert.equal(store.rows[0]!.unsubscribed, true);
  transport.messages.length = 0;
  await service.sendIssue(
    { ...issue, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    now,
  );
  assert.equal(transport.messages.length, 0);
  assert.equal(
    (await service.unsubscribeLink("garbage", "POST", now)).status,
    404,
  );
});

function resendRequest(body: unknown, at = now, secret = whsec) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = createHmac(
    "sha256",
    Buffer.from(secret.replace(/^whsec_/, ""), "base64"),
  )
    .update(`msg_1.${timestamp}.${raw}`)
    .digest("base64");
  return {
    raw,
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": timestamp,
      "svix-signature": `v1,invalid v1,${signature}`,
    },
  };
}

test("hard bounces and complaints stop mail; soft bounces and bad signatures do not", async () => {
  const { store, transport, service } = emailSetup();
  await verified(service, store, "7", "hard@example.com");
  await verified(service, store, "8", "soft@example.com");
  await verified(service, store, "9", "spam@example.com");
  transport.messages.length = 0;
  const bounce = (to: string, type: string) =>
    resendRequest({
      type: "email.bounced",
      data: { to: [to], bounce: { type } },
    });
  const apply = async (r: ReturnType<typeof resendRequest>) =>
    (await service.webhook("resend", r.headers, r.raw, now)).status;
  assert.equal(await apply(bounce("hard@example.com", "Permanent")), 200);
  assert.equal(await apply(bounce("soft@example.com", "Transient")), 200);
  assert.equal(
    await apply(
      resendRequest({
        type: "email.complained",
        data: { to: ["spam@example.com"] },
      }),
    ),
    200,
  );
  const forged = resendRequest(
    {
      type: "email.bounced",
      data: { to: ["soft@example.com"], bounce: { type: "Permanent" } },
    },
    now,
    `whsec_${Buffer.from("other").toString("base64")}`,
  );
  assert.equal(await apply(forged), 401);
  const stale = resendRequest(
    { type: "email.complained", data: { to: ["soft@example.com"] } },
    new Date(now.getTime() - 3600_000),
  );
  assert.equal(await apply(stale), 401);
  assert.equal((await service.webhook("postmark", {}, "{}", now)).status, 404);
  assert.deepEqual(
    store.rows.map((r) => r.bounceState),
    ["hard", "none", "complaint"],
  );
  await service.sendIssue(issue, now);
  assert.deepEqual(
    transport.messages.map((m) => m.to),
    ["soft@example.com"],
  );
});

test("postmark webhooks need the Basic credentials and map bounce types", async () => {
  const { store, service } = emailSetup("postmark");
  await verified(service, store, "7", "a@example.com");
  const raw = JSON.stringify({
    RecordType: "Bounce",
    Type: "HardBounce",
    TypeCode: 1,
    Email: "a@example.com",
  });
  assert.equal((await service.webhook("postmark", {}, raw, now)).status, 401);
  assert.equal(
    (
      await service.webhook(
        "postmark",
        { authorization: "Basic bm9wZTpub3Bl" },
        raw,
        now,
      )
    ).status,
    401,
  );
  const auth = `Basic ${Buffer.from("hook:pass").toString("base64")}`;
  assert.equal(
    (await service.webhook("postmark", { authorization: auth }, raw, now))
      .status,
    200,
  );
  assert.equal(store.rows[0]!.bounceState, "hard");
  assert.equal(
    (await service.webhook("postmark", { authorization: auth }, "{", now))
      .status,
    400,
  );
  assert.equal(verifyPostmarkWebhook("hook:pass", auth), true);
  assert.deepEqual(
    parseEmailWebhook("postmark", {
      RecordType: "SpamComplaint",
      Email: "x@example.com",
    }),
    [{ address: "x@example.com", kind: "complaint" }],
  );
  assert.deepEqual(
    parseEmailWebhook("postmark", {
      RecordType: "Bounce",
      Type: "SoftBounce",
      TypeCode: 4096,
      Email: "x@example.com",
    }),
    [{ address: "x@example.com", kind: "soft" }],
  );
  assert.deepEqual(
    parseEmailWebhook("resend", {
      type: "email.delivered",
      data: { to: ["x@example.com"] },
    }),
    [],
  );
  assert.equal(verifyResendWebhook(whsec, {}, "{}", now), false);
});

test("nothing is sent while the channel is disabled or unconfigured", async () => {
  const transport = new MemoryEmailTransport();
  const adapter = new EmailDeliveryAdapter(transport, {
    from: "n@rapi.example",
  });
  const base = {
    EMAIL_ENABLED: false,
    EMAIL_PROVIDER: "resend" as const,
    EMAIL_WEBHOOK_SECRET: whsec,
    WEBHOOK_ENCRYPTION_KEY: "k".repeat(32),
    RAPI_PUBLIC_BASE_URL: "https://rapi.example",
  };
  const { store, service: seeded, transport: seededMail } = emailSetup();
  assert.equal(createEmailService(base, store as never, adapter), undefined);
  assert.ok(
    createEmailService(
      { ...base, EMAIL_ENABLED: true },
      store as never,
      adapter,
    ),
  );
  assert.equal(
    createEmailService(
      { ...base, EMAIL_ENABLED: true, EMAIL_WEBHOOK_SECRET: undefined },
      store as never,
      adapter,
    ),
    undefined,
  );

  // A learner experiment without the email channel mails nobody, even with verified addresses.
  await verified(seeded, store, "7", "a@example.com");
  seededMail.messages.length = 0;
  const sentTo: string[] = [];
  const learnerStore = {
    async learnerDecideIssue() {
      return true;
    },
    async learnerIssue() {
      return { ...issue };
    },
    async learnerActiveSubscribers() {
      return [{ userId: "7", emailAsked: true }];
    },
    async learnerRecordDelivery() {},
    async learnerMarkEmailAsked() {},
    async learnerFinishIssue() {},
    async learnerDeliveryCounts() {
      return { sent: 1, failed: 0 };
    },
  };
  const options = {
    superadminIds: ["1"],
    linkSecret: "k".repeat(32),
    baseUrl: "https://rapi.example",
    pauseMs: 0,
  };
  const delivery = {
    async send(target: { recipientId: string }) {
      sentTo.push(target.recipientId);
      return { providerId: "m" };
    },
  };
  const off = new LearnerExperiment(learnerStore as never, delivery, options);
  assert.match(await off.sendIssue(issue.id, "1"), /DM 성공 1명/);
  assert.equal(transport.messages.length, 0);
  assert.equal(seededMail.messages.length, 0);

  // Enabled: the same approved send also mails, and an email failure never breaks it.
  const { service } = emailSetup();
  const on = new LearnerExperiment(learnerStore as never, delivery, {
    ...options,
    email: { sendIssue: () => service.sendIssue(issue, now) },
  });
  assert.match(await on.sendIssue(issue.id, "1"), /메일 성공 0명/);
  const broken = new LearnerExperiment(learnerStore as never, delivery, {
    ...options,
    email: {
      sendIssue: async () => {
        throw new Error("db down");
      },
    },
  });
  assert.match(await broken.sendIssue(issue.id, "1"), /메일 발송 중 오류/);
});

test("email config is off by default and the enabled flag needs its settings", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
    DISCORD_BOT_TOKEN: "t",
    DISCORD_APPLICATION_ID: "1",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    DISCORD_ALLOWED_USER_IDS: "1",
  };
  assert.equal(loadEnvironment(base).EMAIL_ENABLED, false);
  assert.throws(
    () => loadEnvironment({ ...base, EMAIL_ENABLED: "true" }),
    /EMAIL_ENABLED/,
  );
});

test("privacy deletion and retention cover email addresses and their deliveries", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  await deleteUserEmails(client as never, "7");
  assert.ok(
    queries.some(
      (q) =>
        /DELETE FROM learner_emails WHERE user_id=\$1/.test(q.sql) &&
        q.params[0] === "7",
    ),
  );
  assert.ok(
    queries.some((q) => /DELETE FROM learner_email_deliveries/.test(q.sql)),
  );
  queries.length = 0;
  await expireEmails(client as never, now);
  const text = queries.map((q) => q.sql).join("\n");
  assert.match(text, /verified_at IS NULL AND created_at/);
  assert.match(text, /bounce_state IN\('hard','complaint'\)/);
  assert.match(text, /learner_email_deliveries WHERE at</);
});

test("transports send the provider's request shape and classify failures", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const respond = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: typeof url === "string" ? url : "", init: init! });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  const message = {
    from: "n@rapi.example",
    to: "a@example.com",
    subject: "s",
    text: "t",
    html: "<p>h</p>",
    headers: { "List-Unsubscribe": "<https://x>" },
    idempotencyKey: "k1",
  };
  const resend = new ResendEmailTransport("re_key", respond(200, { id: "r1" }));
  assert.deepEqual(await resend.send(message), { providerId: "r1" });
  const sent = JSON.parse(calls[0]!.init.body as string) as {
    to: string[];
    headers: Record<string, string>;
  };
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  assert.deepEqual(sent.to, ["a@example.com"]);
  assert.equal(sent.headers["List-Unsubscribe"], "<https://x>");
  assert.equal(
    (calls[0]!.init.headers as Record<string, string>)["idempotency-key"],
    "k1",
  );
  const postmark = new PostmarkEmailTransport(
    "pm_key",
    respond(200, { ErrorCode: 0, MessageID: "p1" }),
  );
  assert.deepEqual(await postmark.send(message), { providerId: "p1" });
  const body = JSON.parse(calls[1]!.init.body as string) as {
    Headers: unknown;
  };
  assert.deepEqual(body.Headers, [
    { Name: "List-Unsubscribe", Value: "<https://x>" },
  ]);
  assert.equal(
    (calls[1]!.init.headers as Record<string, string>)[
      "x-postmark-server-token"
    ],
    "pm_key",
  );
  await assert.rejects(
    new ResendEmailTransport("k", respond(422, {})).send(message),
    PermanentDeliveryError,
  );
  await assert.rejects(
    new ResendEmailTransport("k", respond(500, {})).send(message),
    /500/,
  );
  const adapter = new EmailDeliveryAdapter(new MemoryEmailTransport(), {
    from: "n@rapi.example",
  });
  await assert.rejects(
    adapter.send(
      { channel: "email", recipientId: "a@example.com\r\nBcc: x" },
      { subject: "s", text: "", html: "", itemIds: [] },
      "k",
    ),
    /newline/,
  );
});

test("the bot serves email pages, webhooks and the address modal", async () => {
  const { store, transport, service } = emailSetup();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const bot = createDiscordInteractionServer(
    new DiscordCommandService({} as RapiAgent, { userIds: [] }),
    publicHex,
    {
      email: {
        page: (kind, token, method) =>
          kind === "verify"
            ? service.verifyLink(token, method)
            : service.unsubscribeLink(token, method),
        webhook: (provider, headers, rawBody) =>
          service.webhook(provider, headers, rawBody),
        register: (userId, address) => service.register(userId, address),
      },
    },
  );
  bot.listen(0, "127.0.0.1");
  await once(bot, "listening");
  const address = bot.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const interact = async (body: object) => {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await fetch(`${base}/interactions`, {
        method: "POST",
        body: raw,
        headers: {
          "x-signature-ed25519": sign(
            null,
            Buffer.from(timestamp + raw),
            privateKey,
          ).toString("hex"),
          "x-signature-timestamp": timestamp,
        },
      });
      return (await response.json()) as {
        type: number;
        data: { content?: string; custom_id?: string };
      };
    };
    const user = { user: { id: "123456789012345678" } };
    const modal = await interact({
      type: 3,
      ...user,
      data: { custom_id: "email_add" },
    });
    assert.equal(modal.type, 9);
    assert.equal(modal.data.custom_id, "email_add_modal");
    const submitted = await interact({
      type: 5,
      ...user,
      data: {
        custom_id: "email_add_modal",
        components: [
          { components: [{ custom_id: "address", value: "me@example.com" }] },
        ],
      },
    });
    assert.equal(submitted.type, 4);
    assert.match(submitted.data.content ?? "", /확인 메일을 보냈어요/);
    assert.equal(transport.messages.length, 1);

    const token = tokenFrom(transport.messages[0]!.text, "verify");
    const get = await fetch(`${base}/e/verify/${token}`);
    assert.equal(get.status, 200);
    assert.match(get.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(get.headers.get("x-robots-tag"), "noindex");
    assert.match(
      get.headers.get("content-security-policy") ?? "",
      /default-src 'none'/,
    );
    assert.equal(store.rows[0]!.verified, false);
    assert.equal(
      (await fetch(`${base}/e/verify/${token}`, { method: "POST", body: "x" }))
        .status,
      200,
    );
    assert.equal(store.rows[0]!.verified, true);
    assert.equal((await fetch(`${base}/e/verify/bad`)).status, 404);
    assert.equal(
      (await fetch(`${base}/e/verify/${token}`, { method: "PUT" })).status,
      404,
    );

    const hook = resendRequest(
      {
        type: "email.bounced",
        data: { to: ["me@example.com"], bounce: { type: "Permanent" } },
      },
      new Date(),
    );
    const posted = await fetch(`${base}/e/webhook/resend`, {
      method: "POST",
      body: hook.raw,
      headers: hook.headers,
    });
    assert.equal(posted.status, 200);
    assert.equal(store.rows[0]!.bounceState, "hard");
    assert.equal(
      (
        await fetch(`${base}/e/webhook/resend`, {
          method: "POST",
          body: hook.raw,
        })
      ).status,
      401,
    );
    assert.equal((await fetch(`${base}/e/webhook/resend`)).status, 404);
  } finally {
    bot.closeAllConnections();
    await new Promise<void>((resolve) => bot.close(() => resolve()));
  }
});
