import assert from "node:assert/strict";
import { test } from "node:test";
import { cardPayload, discordEmbed } from "@rapi/core";

test("a card becomes an embed with the accent color and clipped fields", () => {
  const embed = discordEmbed({
    title: "t".repeat(400),
    description: "d",
    fields: [
      { name: "n", value: "v".repeat(2000) },
      { name: "e", value: "" },
    ],
    footer: "f",
  }) as {
    title: string;
    color: number;
    fields: Array<{ value: string }>;
    footer: { text: string };
  };
  assert.equal(embed.title.length, 256);
  assert.equal(embed.fields[0]!.value.length, 1024);
  assert.equal(embed.fields[1]!.value, "-");
  assert.equal(embed.footer.text, "f");
  assert.equal(embed.color, 0x365d46);
});

test("a message keeps to Discord's ten embeds and total size", () => {
  const cards = Array.from({ length: 14 }, (_, i) => ({
    title: `repo-${i}`,
    description: "x".repeat(3000),
  }));
  const payload = cardPayload("s", "plain", cards);
  const embeds = payload.discord!.embeds;
  assert.ok(embeds.length >= 1 && embeds.length <= 10);
  assert.ok(JSON.stringify(embeds).length <= 6000 + 400);
  assert.equal(payload.text, "plain");
});
