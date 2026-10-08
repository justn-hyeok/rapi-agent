import assert from "node:assert/strict";
import { test } from "node:test";
import {
  briefingLinkKey,
  renderBriefing,
  renderBriefingPage,
  signBriefingToken,
  verifyBriefingToken,
  type BriefingItem,
} from "@rapi/core";
import { DiscordDeliveryAdapter } from "@rapi/adapters";

const key = briefingLinkKey("x".repeat(32));
const batch = "11111111-1111-4111-8111-111111111111";

test("briefing links verify only for their batch, key and lifetime", () => {
  const now = new Date("2026-10-08T00:00:00Z");
  const token = signBriefingToken(key, batch, now);
  assert.ok(verifyBriefingToken(key, batch, token, now));
  assert.ok(
    !verifyBriefingToken(
      key,
      "22222222-2222-4222-8222-222222222222",
      token,
      now,
    ),
  );
  assert.ok(
    !verifyBriefingToken(briefingLinkKey("y".repeat(32)), batch, token, now),
  );
  assert.ok(!verifyBriefingToken(key, batch, `${token.slice(0, -1)}A`, now));
  assert.ok(
    !verifyBriefingToken(key, batch, token, new Date("2026-10-23T00:00:00Z")),
  );
  assert.ok(!verifyBriefingToken(key, batch, "garbage", now));
});

test("the page escapes content, groups by section and carries a nonce", () => {
  const { html, nonce } = renderBriefingPage(
    {
      batchId: batch,
      token: "1.t",
      dateLabel: "2026년 10월 8일 수요일",
      entries: [
        {
          id: "a",
          title: '<script>alert("x")</script>',
          url: "https://example.com/a?x=1&y=2",
          summary: "요약",
          source: "HN",
          section: "industry",
          meta: "10월 7일",
          repository: false,
          feedback: { up: true, down: false, save: false },
        },
        {
          id: "b",
          title: "owner/repo",
          url: "https://github.com/owner/repo",
          summary: "설명",
          why: "devswha가 최근 star",
          source: "GitHub 추천",
          section: "github",
          meta: "★10",
          repository: true,
          feedback: { up: false, down: false, save: true },
        },
      ],
    },
    "fixednonce",
  );
  assert.equal(nonce, "fixednonce");
  assert.ok(!html.includes('<script>alert("x")'));
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)/);
  assert.match(html, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
  assert.match(html, /<script nonce="fixednonce">/);
  assert.match(html, /data-section="industry"[\s\S]*data-section="github"/);
  assert.match(html, /data-k="up" aria-pressed="true"/);
  assert.match(html, /class="why">devswha가 최근 star/);
  assert.match(html, /오늘 볼 것 2건/);
});

const item = (
  id: string,
  title: string,
  groupKey: string | null = null,
): BriefingItem => ({
  id,
  title,
  canonicalUrl: `https://example.com/${id}`,
  summary: `${title} 요약`,
  categories: [],
  visibility: "public",
  groupKey,
});

test("a linked briefing becomes one Discord card with the top three and a link button", () => {
  const payload = renderBriefing(
    "Rapi daily briefing",
    [
      item("1", "첫째"),
      item("2", "둘째", "a/b"),
      item("3", "셋째", "a/b"),
      item("4", "넷째"),
      item("5", "다섯째"),
    ],
    { link: "https://rapi.example/b/x?t=1", dateLabel: "10월 8일 (수)" },
  );
  const embed = payload.discord!.embeds[0] as {
    title: string;
    description: string;
    url: string;
  };
  assert.equal(embed.title, "오늘 볼 것 4건");
  assert.equal(embed.url, "https://rapi.example/b/x?t=1");
  assert.equal(embed.description.split("\n\n").length, 3);
  assert.match(embed.description, /a\/b · GitHub 활동 2건/);
  assert.ok(!embed.description.includes("다섯째"));
  assert.deepEqual(payload.itemIds, ["1", "2", "3", "4", "5"]);
  assert.match(payload.text, /전체 보기: https:\/\/rapi\.example\/b\/x\?t=1/);
  assert.equal(renderBriefing("t", [item("1", "a")]).discord, undefined);
});

test("the Discord adapter sends a card as one message", async () => {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ id: String(bodies.length) }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const result = await new DiscordDeliveryAdapter("token").send(
      { channel: "discord_channel", recipientId: "123" },
      {
        subject: "s",
        text: "x".repeat(5000),
        html: "",
        itemIds: [],
        discord: { embeds: [{ title: "t" }] },
      },
    );
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0]!.embeds, [{ title: "t" }]);
    assert.equal(bodies[0]!.content, undefined);
    assert.equal(result.providerId, "1");
  } finally {
    globalThis.fetch = original;
  }
});
