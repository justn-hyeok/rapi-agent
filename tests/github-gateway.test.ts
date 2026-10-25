import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";
import {
  DiscordCommandService,
  GitHubWebhookReceiver,
  type RapiAgent,
} from "@rapi/agent";

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("public gateway forwards only POST /github/webhook and the bot verifies it", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const secret = "gateway-secret-0123456789";
  const queued: string[] = [];
  const bot = createDiscordInteractionServer(
    new DiscordCommandService({} as RapiAgent, { userIds: [] }),
    publicHex,
    {
      github: new GitHubWebhookReceiver({
        secret,
        policy: { allowedOwners: ["owner"], ownerLogins: ["justn"] },
        store: {
          enqueue: async (delivery) => {
            queued.push(delivery.deliveryId);
            return true;
          },
        },
      }),
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
    const url = `http://127.0.0.1:${port}/github/webhook`;
    assert.equal((await fetch(url)).status, 404);
    assert.equal(
      (await fetch(url + "/extra", { method: "POST", body: "{}" })).status,
      404,
    );
    const body = JSON.stringify({
      action: "created",
      installation: { id: 1 },
      repository: { full_name: "owner/app", owner: { login: "owner" } },
      sender: { login: "justn", type: "User" },
      issue: { number: 1 },
      comment: { id: 2, body: "@rapi 안녕" },
    });
    const headers = {
      "x-github-event": "issue_comment",
      "x-github-delivery": "gw-1",
    };
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          body,
          headers: {
            ...headers,
            "x-hub-signature-256": "sha256=" + "0".repeat(64),
          },
        })
      ).status,
      401,
    );
    const ok = await fetch(url, {
      method: "POST",
      body,
      headers: {
        ...headers,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    });
    assert.equal(ok.status, 202);
    assert.deepEqual(queued, ["gw-1"]);
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
