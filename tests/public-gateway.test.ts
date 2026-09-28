import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createDiscordInteractionServer } from "../apps/bot/src/discord-http.js";
import { DiscordCommandService, type RapiAgent } from "@rapi/agent";

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
      "/omp/callback",
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
