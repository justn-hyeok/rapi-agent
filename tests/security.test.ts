import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { verifyWebhookSignature } from "@rapi/adapters";
import {
  assertDiscordAccess,
  canonicalizeUrl,
  splitDiscordMessage,
} from "@rapi/core";
import {
  slashCommandDefinitions,
  verifyDiscordRequest,
} from "../apps/bot/src/discord-http.js";
import { requiredCommandAccess } from "../packages/agent/src/discord-commands.js";

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

  it("registers simple Korean slash commands", () => {
    assert.equal(slashCommandDefinitions.length, 11);
    assert.deepEqual(
      slashCommandDefinitions.map((command) => command.name),
      [
        "브리핑",
        "검색",
        "구독",
        "구독해제",
        "수집원",
        "발송내역",
        "대화채널",
        "대화해제",
        "작업",
        "승인",
        "취소",
      ],
    );
    const subscribe = slashCommandDefinitions.find(
      (command) => command.name === "구독",
    );
    const approve = slashCommandDefinitions.find(
      (command) => command.name === "승인",
    );
    const task = slashCommandDefinitions.find(
      (command) => command.name === "작업",
    );
    assert.deepEqual(
      subscribe?.options?.map((option) => option.name),
      ["이름", "키워드", "분야", "주기"],
    );
    assert.equal(approve?.options, undefined);
    assert.deepEqual(
      task?.options?.map((option) => option.name),
      ["내용", "공급자", "모델"],
    );
  });

  it("allows every channel when no channel allowlist is configured", () => {
    assert.doesNotThrow(() =>
      assertDiscordAccess(
        { userId: "100", guildId: "200", channelId: "300" },
        { userIds: ["100"], guildIds: ["200"] },
      ),
    );
  });

  it("resolves USER, ADMIN and SUPERADMIN without role escalation", () => {
    const policy = {
      userIds: ["owner"],
      adminRoleIds: ["admin-role"],
      userRoleIds: ["user-role"],
      guildIds: ["guild"],
    };
    assert.equal(
      assertDiscordAccess({ userId: "owner", guildId: "guild" }, policy),
      "superadmin",
    );
    assert.equal(
      assertDiscordAccess(
        { userId: "admin", guildId: "guild", roleIds: ["admin-role"] },
        policy,
      ),
      "admin",
    );
    assert.equal(
      assertDiscordAccess(
        { userId: "member", guildId: "guild", roleIds: ["user-role"] },
        policy,
      ),
      "user",
    );
    assert.throws(
      () =>
        assertDiscordAccess(
          { userId: "member", guildId: "guild", roleIds: ["user-role"] },
          policy,
          "admin",
        ),
      /ADMIN/,
    );
    assert.throws(
      () =>
        assertDiscordAccess(
          { userId: "intruder", guildId: "guild", roleIds: ["other"] },
          policy,
        ),
      /not allowed/,
    );
  });

  it("assigns command tiers", () => {
    assert.equal(requiredCommandAccess("search"), "user");
    assert.equal(requiredCommandAccess("chat_enable"), "admin");
    assert.equal(requiredCommandAccess("task"), "superadmin");
    assert.equal(requiredCommandAccess("approve"), "superadmin");
  });
});
