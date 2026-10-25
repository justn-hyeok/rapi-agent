import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";
import { DiscordCommandService, type RapiAgent } from "@rapi/agent";
import {
  learnerLinkKey,
  signLearnerLink,
  signWebUnsubscribe,
  verifyLearnerLink,
  webUnsubscribeKey,
} from "@rapi/core";

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("public gateway denies private routes, forwards signed interactions and fails readiness with its upstream", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const service = new DiscordCommandService({} as RapiAgent, { userIds: [] });
  let ready = true;
  const bot = createDiscordInteractionServer(service, publicHex, {
    async readiness() {
      return { ready };
    },
  });
  bot.listen(0, "127.0.0.1");
  await once(bot, "listening");
  const address = bot.address();
  assert.ok(address && typeof address === "object");
  const port = await freePort();
  const health = await freePort();
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["ops/gateway/run.mjs"], {
      env: {
        ...process.env,
        PORT: String(address.port),
        RAPI_GATEWAY_PORT: String(port),
        RAPI_GATEWAY_HEALTH_PORT: String(health),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout!, "data");
    const base = `http://127.0.0.1:${port}`;
    for (const path of [
      "/health",
      "/ready",
      "/v1/answer",
      "/interactions/extra",
      "/%69nteractions",
    ]) {
      assert.equal((await fetch(base + path, { method: "POST" })).status, 404);
    }
    assert.equal((await fetch(base + "/interactions")).status, 404);
    assert.equal(
      (await fetch(base + "/interactions", { method: "POST", body: "{}" }))
        .status,
      401,
    );
    const body = '{"type":1}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(
      null,
      Buffer.from(timestamp + body),
      privateKey,
    ).toString("hex");
    const interaction = await fetch(base + "/interactions", {
      method: "POST",
      body,
      headers: {
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      },
    });
    assert.equal(interaction.status, 200);
    assert.deepEqual(await interaction.json(), { type: 1 });
    assert.equal((await fetch(`http://127.0.0.1:${health}/ready`)).status, 200);
    ready = false;
    assert.equal((await fetch(`http://127.0.0.1:${health}/ready`)).status, 503);
  } finally {
    if (child) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    bot.closeAllConnections();
    await new Promise<void>((resolve) => bot.close(() => resolve()));
  }
});

test("public gateway forwards only well-formed learner click links", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const key = learnerLinkKey("g".repeat(32));
  const itemId = "11111111-1111-4111-8111-111111111111";
  const token = signLearnerLink(key, itemId, "123456789012345678");
  const seen: string[] = [];
  const bot = createDiscordInteractionServer(
    new DiscordCommandService({} as RapiAgent, { userIds: [] }),
    publicHex,
    {
      learner: {
        async handle() {
          return { content: "" };
        },
        async link(candidate) {
          seen.push(candidate);
          return verifyLearnerLink(key, candidate)
            ? "https://example.com/stored"
            : null;
        },
      },
    },
  );
  bot.listen(0, "127.0.0.1");
  await once(bot, "listening");
  const address = bot.address();
  assert.ok(address && typeof address === "object");
  const port = await freePort();
  const health = await freePort();
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["ops/gateway/run.mjs"], {
      env: {
        ...process.env,
        PORT: String(address.port),
        RAPI_GATEWAY_PORT: String(port),
        RAPI_GATEWAY_HEALTH_PORT: String(health),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout!, "data");
    const base = `http://127.0.0.1:${port}`;
    const hit = await fetch(`${base}/r/${token}`, { redirect: "manual" });
    assert.equal(hit.status, 302);
    assert.equal(hit.headers.get("location"), "https://example.com/stored");
    const bad = [
      `/r/${token}/extra`,
      `/r/${token}x`,
      "/r/abc",
      `/r/${token.replace(/\.[^.]+$/, ".short")}`,
      `/r/..%2Finteractions`,
    ];
    for (const path of bad)
      assert.equal((await fetch(base + path)).status, 404, path);
    assert.equal(
      (await fetch(`${base}/r/${token}`, { method: "POST" })).status,
      404,
    );
    assert.deepEqual(seen, [token]);
    const forged = `${token.slice(0, -3)}AAA`;
    assert.equal((await fetch(`${base}/r/${forged}`)).status, 404);
  } finally {
    if (child) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    bot.closeAllConnections();
    await new Promise<void>((resolve) => bot.close(() => resolve()));
  }
});

test("public gateway forwards only the well-formed web paths and methods", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const token = signWebUnsubscribe(
    webUnsubscribeKey("w".repeat(32)),
    "123456789012345678",
  );
  const seen: string[] = [];
  const bot = createDiscordInteractionServer(
    new DiscordCommandService({} as RapiAgent, { userIds: [] }),
    publicHex,
    {
      web: {
        async handle(request) {
          seen.push(`${request.method} ${request.path}`);
          return {
            status: 200,
            headers: { "content-type": "text/plain", "set-cookie": "a=b" },
            body: "web",
          };
        },
      },
    },
  );
  bot.listen(0, "127.0.0.1");
  await once(bot, "listening");
  const address = bot.address();
  assert.ok(address && typeof address === "object");
  const port = await freePort();
  const health = await freePort();
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["ops/gateway/run.mjs"], {
      env: {
        ...process.env,
        PORT: String(address.port),
        RAPI_GATEWAY_PORT: String(port),
        RAPI_GATEWAY_HEALTH_PORT: String(health),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout!, "data");
    const base = `http://127.0.0.1:${port}`;
    const allowed: Array<[string, string]> = [
      ["GET", "/auth/discord/login"],
      ["GET", "/auth/discord/callback?code=a&state=b"],
      ["POST", "/logout"],
      ["GET", "/me"],
      ["POST", "/me/subscription"],
      ["POST", "/me/email"],
      ["GET", "/admin"],
      ["GET", "/admin/subscribe"],
      ["POST", "/admin/subscribe"],
      ["GET", "/admin/unsubscribe"],
      ["POST", "/admin/unsubscribe"],
      ["GET", "/admin/sources"],
      ["GET", "/admin/deliveries"],
      ["GET", "/admin/status"],
      ["GET", "/admin/usage?guild=123456789012345678"],
      ["GET", "/admin/usage-policy"],
      ["POST", "/admin/usage-policy"],
      ["GET", "/admin/server-config?guild=1&format=yaml"],
      ["POST", "/admin/server-config"],
      ["GET", "/admin/webhooks"],
      ["POST", "/admin/webhooks"],
      ["GET", "/admin/billing"],
      ["POST", "/admin/billing"],
      ["GET", "/billing"],
      ["GET", "/billing/checkout?plan=supporter"],
      ["GET", "/billing/success?paymentKey=k&orderId=rapi_abc123&amount=1000"],
      ["GET", "/billing/fail?code=PAY_PROCESS_CANCELED&orderId=rapi_abc123"],
      ["POST", "/billing/webhook/toss"],
      ["GET", "/archive"],
      ["GET", "/archive/weekly-2026-10-19"],
      ["GET", "/archive/daily-2026-10-19"],
      ["GET", "/archive/blog/guide-1234"],
      ["GET", `/u/${token}`],
      ["POST", `/u/${token}`],
    ];
    for (const [method, path] of allowed) {
      const reply = await fetch(base + path, {
        method,
        ...(method === "POST" ? { body: "csrf=x" } : {}),
      });
      assert.equal(reply.status, 200, `${method} ${path}`);
      assert.equal(reply.headers.get("set-cookie"), "a=b");
    }
    assert.equal(seen.length, allowed.length);
    const denied: Array<[string, string]> = [
      ["POST", "/auth/discord/login"],
      ["POST", "/auth/discord/callback"],
      ["GET", "/auth/discord/other"],
      ["GET", "/logout"],
      ["GET", "/me/subscription"],
      ["GET", "/me/email"],
      ["POST", "/me/email/x"],
      ["POST", "/me"],
      ["GET", "/me/"],
      ["GET", "/me/admin"],
      ["POST", "/archive"],
      ["GET", "/archive/"],
      ["GET", "/archive/weekly-2026-10-1"],
      ["GET", "/archive/monthly-2026-10-19"],
      ["GET", "/archive/weekly-2026-10-19/x"],
      ["GET", "/archive/..%2Finteractions"],
      ["GET", "/archive/blog"],
      ["GET", "/archive/blog/"],
      ["GET", "/archive/blog/Bad_Slug"],
      ["GET", "/archive/blog/a/b"],
      ["GET", `/archive/blog/${"a".repeat(101)}`],
      ["POST", "/archive/blog/guide-1234"],
      ["GET", `/u/${token}/x`],
      ["GET", `/u/${token}x`],
      ["GET", "/u/abc"],
      ["PUT", `/u/${token}`],
      ["DELETE", "/me"],
      ["POST", "/billing"],
      ["GET", "/billing/"],
      ["GET", "/billing/webhook/toss"],
      ["POST", "/billing/checkout"],
      ["POST", "/billing/success"],
      ["POST", "/billing/fail"],
      ["GET", "/billing/other"],
      ["GET", "/billing/checkout/x"],
      ["GET", "/billing/..%2Finteractions"],
      ["POST", "/billing/webhook/toss/x"],
      ["GET", "/admin/billing/x"],
      ["POST", "/admin"],
      ["GET", "/admin/"],
      ["GET", "/admin/other"],
      ["GET", "/admin/status/x"],
      ["GET", "/admin/status.json"],
      ["GET", "/admin/..%2Finteractions"],
      ["POST", "/admin/status"],
      ["POST", "/admin/sources"],
      ["POST", "/admin/usage"],
      ["PUT", "/admin/webhooks"],
      ["DELETE", "/admin/webhooks"],
    ];
    for (const [method, path] of denied)
      assert.equal(
        (await fetch(base + path, { method })).status,
        404,
        `${method} ${path}`,
      );
    assert.equal(
      seen.length,
      allowed.length,
      "denied requests never reach the bot",
    );
  } finally {
    if (child) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    bot.closeAllConnections();
    await new Promise<void>((resolve) => bot.close(() => resolve()));
  }
});

test("public gateway forwards only well-formed email links and webhooks", async () => {
  const seen: string[] = [];
  const upstream = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.end("ok");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const port = await freePort();
  const health = await freePort();
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["ops/gateway/run.mjs"], {
      env: {
        ...process.env,
        PORT: String(address.port),
        RAPI_GATEWAY_PORT: String(port),
        RAPI_GATEWAY_HEALTH_PORT: String(health),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(child.stdout!, "data");
    const base = `http://127.0.0.1:${port}`;
    const token = `11111111-1111-4111-8111-111111111111.1790000000.${"A".repeat(43)}`;
    for (const [method, path] of [
      ["GET", `/e/verify/${token}`],
      ["POST", `/e/verify/${token}`],
      ["GET", `/e/unsub/${token}`],
      ["POST", `/e/unsub/${token}?x=1`],
      ["POST", "/e/webhook/resend"],
      ["POST", "/e/webhook/postmark"],
    ] as const)
      assert.equal(
        (
          await fetch(base + path, {
            method,
            ...(method === "POST" ? { body: "{}" } : {}),
          })
        ).status,
        200,
        `${method} ${path}`,
      );
    assert.equal(seen.length, 6);
    const bad: Array<[string, string]> = [
      ["GET", `/e/verify/${token}/extra`],
      ["GET", `/e/verify/${token}x`],
      ["GET", "/e/verify/abc"],
      ["GET", `/e/verify/${token.replace(/\.[^.]+$/, ".short")}`],
      ["GET", "/e/verify/..%2Finteractions"],
      ["GET", `/e/other/${token}`],
      ["PUT", `/e/unsub/${token}`],
      ["DELETE", `/e/unsub/${token}`],
      ["GET", "/e/webhook/resend"],
      ["POST", "/e/webhook/sendgrid"],
      ["POST", "/e/webhook/resend/extra"],
      ["POST", "/e/webhook/Resend"],
      ["POST", "/e/webhook/"],
      ["POST", "/e/"],
    ];
    for (const [method, path] of bad)
      assert.equal(
        (
          await fetch(base + path, {
            method,
            ...(method === "POST" ? { body: "{}" } : {}),
          })
        ).status,
        404,
        `${method} ${path}`,
      );
    assert.equal(seen.length, 6);
  } finally {
    if (child) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
