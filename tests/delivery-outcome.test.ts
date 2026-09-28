import assert from "node:assert/strict";
import test from "node:test";
import { DiscordDeliveryAdapter, UncertainDeliveryError } from "@rapi/adapters";

const target = { channel: "discord_channel" as const, recipientId: "123" };
const payload = { subject: "briefing", text: "hello", html: "<p>hello</p>" };

test("Discord partial delivery and lost acknowledgement cannot become automatic replays", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.ok(init?.signal);
    if (typeof init.body !== "string") throw new Error("Expected JSON body");
    const body = JSON.parse(init.body) as {
      allowed_mentions: { parse: string[] };
    };
    assert.deepEqual(body.allowed_mentions.parse, []);
    return calls === 1
      ? Response.json({ id: "accepted" })
      : new Response("failure", { status: 500 });
  };
  try {
    await assert.rejects(
      new DiscordDeliveryAdapter("token").send(target, {
        ...payload,
        text: "x ".repeat(2500),
      }),
      UncertainDeliveryError,
    );
    assert.equal(calls, 2);
    globalThis.fetch = async () => new Response("broken json", { status: 200 });
    await assert.rejects(
      new DiscordDeliveryAdapter("token").send(target, payload),
      UncertainDeliveryError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Discord message network failure is surfaced as an uncertain outcome", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connection reset");
  };
  try {
    await assert.rejects(
      new DiscordDeliveryAdapter("token").send(target, payload),
      (error: unknown) =>
        error instanceof UncertainDeliveryError && error.possiblyDelivered,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Discord HTTP failure remains a known non-uncertain error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("server error", { status: 500 });
  try {
    await assert.rejects(
      new DiscordDeliveryAdapter("token").send(target, payload),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof UncertainDeliveryError) &&
        error.message === "Discord returned 500",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
