import assert from "node:assert/strict";
import test from "node:test";
import { DiscordDeliveryAdapter, UncertainDeliveryError } from "@rapi/adapters";

const target = { channel: "discord_channel" as const, recipientId: "123" };
const payload = { subject: "briefing", text: "hello", html: "<p>hello</p>" };

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
