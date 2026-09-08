import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { verifyWebhookSignature } from "@rapi/adapters";
import { canonicalizeUrl, splitDiscordMessage } from "@rapi/core";
import {
  slashCommandDefinitions,
  verifyDiscordRequest,
} from "../apps/bot/src/discord-http.js";

describe("external input boundaries", () => {
  it("verifies Discord Ed25519 requests", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const body = Buffer.from('{"type":1}');
    const timestamp = "1788831000";
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), body]),
      privateKey,
    );
    const der = publicKey.export({ format: "der", type: "spki" });
    const rawPublicKey = der.subarray(der.length - 32).toString("hex");
    assert.equal(
      verifyDiscordRequest(
        rawPublicKey,
        signature.toString("hex"),
        timestamp,
        body,
      ),
      true,
    );
    assert.equal(
      verifyDiscordRequest(
        rawPublicKey,
        signature.toString("hex"),
        timestamp,
        Buffer.from("changed"),
      ),
      false,
    );
  });

  it("verifies webhook HMAC signatures", () => {
    const body = Buffer.from("payload");
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    assert.equal(verifyWebhookSignature(body, signature, "secret"), true);
    assert.equal(verifyWebhookSignature(body, signature, "wrong"), false);
  });

  it("rejects non-HTTP source URLs and splits Discord output", () => {
    assert.throws(() => canonicalizeUrl("javascript:alert(1)"), /HTTP/);
    const chunks = splitDiscordMessage("x ".repeat(2500));
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 1900));
  });

  it("registers every supported slash command with required inputs", () => {
    assert.equal(slashCommandDefinitions.length, 9);
    const subscribe = slashCommandDefinitions.find(
      (command) => command.name === "subscribe",
    );
    const approve = slashCommandDefinitions.find(
      (command) => command.name === "approve",
    );
    assert.deepEqual(
      subscribe.options.map((option) => option.name),
      ["subscription"],
    );
    assert.deepEqual(
      approve.options.map((option) => option.name),
      ["task_id", "revision", "permissions", "message_ref"],
    );
  });
});
