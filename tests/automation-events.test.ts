import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  AutomationNotifier,
  createAutomationNotifier,
  signAutomationBody,
} from "@rapi/agent";
import { loadEnvironment } from "@rapi/config";
import { isAllowedAutomationUrl } from "@rapi/core";

const event = {
  type: "blog.published",
  data: {
    slug: "guide-1",
    title: "입문",
    url: "https://rapi.example/blog/g.html",
  },
} as const;
const secret = "test".repeat(6);
const now = new Date("2026-10-26T12:00:00Z");

test("signed events carry a timestamp and an HMAC the receiver can recompute", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const notifier = new AutomationNotifier({
    url: "http://127.0.0.1:5678/webhook/rapi-blog",
    secret,
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(await notifier.notify(event), true);
  const { url, init } = seen[0]!;
  const headers = init.headers as Record<string, string>;
  const body = init.body as string;
  assert.equal(url, "http://127.0.0.1:5678/webhook/rapi-blog");
  assert.equal(headers["x-rapi-timestamp"], String(now.getTime() / 1000));
  assert.deepEqual(JSON.parse(body), { ...event, at: now.toISOString() });
  const expected = `sha256=${createHmac("sha256", secret).update(`${headers["x-rapi-timestamp"]}.${body}`).digest("hex")}`;
  assert.equal(headers["x-rapi-signature"], expected);
  assert.equal(
    signAutomationBody(secret, headers["x-rapi-timestamp"]!, body),
    expected,
  );
  assert.equal(init.redirect, "error");
  // A different secret or a replayed timestamp gives a different signature.
  assert.notEqual(signAutomationBody("other".repeat(4), "1", body), expected);
});

test("a down or failing automation tool never throws and is reported", async () => {
  const warnings: string[] = [];
  const answer = (status: number) =>
    new AutomationNotifier({
      url: "https://automation.example/hook",
      secret,
      onWarning: (message) => warnings.push(message),
      fetch: (async () =>
        new Response("no", { status })) as unknown as typeof fetch,
    });
  assert.equal(await answer(500).notify(event), false);
  const broken = new AutomationNotifier({
    url: "https://automation.example/hook",
    secret,
    onWarning: (message) => warnings.push(message),
    fetch: (async () => {
      throw new TypeError("credential leak connection refused");
    }) as unknown as typeof fetch,
  });
  assert.equal(await broken.notify(event), false);
  assert.ok(warnings.some((w) => w.includes("500")));
  // The warning names the error type, never its message (which could carry secrets).
  assert.ok(warnings.every((w) => !w.includes("credential leak")));
});

test("only https or this machine's http may receive events", () => {
  for (const ok of [
    "https://automation.example/hook",
    "http://127.0.0.1:5678/webhook/x",
    "http://localhost:5678/x",
    "http://[::1]:5678/x",
  ])
    assert.equal(isAllowedAutomationUrl(ok), true, ok);
  for (const bad of [
    "http://automation.example/hook",
    "http://192.168.0.5:5678/x",
    "https://user:pass@automation.example/x",
    "ftp://127.0.0.1/x",
    "not a url",
  ])
    assert.equal(isAllowedAutomationUrl(bad), false, bad);
  assert.throws(
    () => new AutomationNotifier({ url: "http://evil.example/x", secret }),
    /https or loopback/,
  );
  assert.equal(createAutomationNotifier({}), undefined);
  assert.equal(
    createAutomationNotifier({ AUTOMATION_WEBHOOK_URL: "https://a.example/x" }),
    undefined,
  );
});

test("config requires the URL and secret together and applies the same URL rule", () => {
  const base = {
    RAPI_ENV: "test",
    DATABASE_URL: "postgresql://rapi:rapi@localhost:5432/rapi",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_APPLICATION_ID: "1234567890",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    DISCORD_ALLOWED_USER_IDS: "100",
  };
  const withAutomation = (url: string, key = secret) =>
    loadEnvironment({
      ...base,
      AUTOMATION_WEBHOOK_URL: url,
      AUTOMATION_WEBHOOK_SECRET: key,
    });
  assert.equal(loadEnvironment(base).AUTOMATION_WEBHOOK_URL, undefined);
  assert.throws(
    () =>
      loadEnvironment({
        ...base,
        AUTOMATION_WEBHOOK_URL: "https://a.example/x",
      }),
    /set together/,
  );
  assert.throws(
    () => loadEnvironment({ ...base, AUTOMATION_WEBHOOK_SECRET: secret }),
    /set together/,
  );
  assert.throws(() => withAutomation("https://a.example/x", "short"));
  // The config copy of the rule agrees with the core one.
  for (const url of [
    "https://automation.example/hook",
    "http://127.0.0.1:5678/webhook/x",
    "http://localhost:5678/x",
    "http://automation.example/hook",
    "http://192.168.0.5:5678/x",
    "https://user:pass@automation.example/x",
  ]) {
    let accepted = true;
    try {
      withAutomation(url);
    } catch {
      accepted = false;
    }
    assert.equal(accepted, isAllowedAutomationUrl(url), url);
  }
});
