import assert from "node:assert/strict";
import { test } from "node:test";
import { composeButtonEmbeds } from "@rapi/agent";
import { cardPayload, contentCard, discordEmbed } from "@rapi/core";

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

test("contentCard takes the first line as the headline", () => {
  const card = contentCard(
    "**senpi 새 버전: 1 → 2**\n릴리스: <https://x.test>\n• 통과",
  );
  assert.equal(card.title, "senpi 새 버전: 1 → 2");
  assert.equal(card.description, "릴리스: <https://x.test>\n• 통과");
});

test("a button result is added as the last card; a confirm prompt is replaced, never stacked", () => {
  const now = new Date("2026-10-27T00:00:00Z");
  const original = [discordEmbed({ title: "초안", description: "본문" })];
  const asked = composeButtonEmbeds(
    original,
    { prompt: "정말 버릴까요?" },
    "9",
    now,
  );
  assert.equal(asked.length, 2);
  assert.equal((asked[1] as { title: string }).title, "❓ 확인");
  const again = composeButtonEmbeds(asked, { prompt: "다시 확인" }, "9", now);
  assert.equal(again.length, 2);
  const done = composeButtonEmbeds(asked, { result: "버렸어요." }, "9", now);
  assert.equal(done.length, 2);
  const result = done[1] as { title: string; description: string };
  assert.equal(result.title, "✅ 처리됨");
  assert.match(result.description, /버렸어요\.\n처리: <@9> · <t:\d+:f>/);
  assert.equal((done[0] as { title: string }).title, "초안");
});
