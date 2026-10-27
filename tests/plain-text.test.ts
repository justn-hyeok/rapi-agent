import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discordMarkdown,
  plainText,
  renderBriefing,
  summarize,
} from "@rapi/core";

const htmlBody =
  '<p>Article URL: <a href="https://x.test/a">https://x.test/a</a></p> <p>Comments URL: <a href="https://x.test/c">c</a></p>';

test("plainText decodes escaped markup before dropping it", () => {
  assert.equal(
    plainText("&lt;div class=&quot;x&quot;&gt;Fix &amp;amp; ship&lt;/div&gt;"),
    "Fix & ship",
  );
  assert.equal(plainText("a &lt;!-- c --&gt; b"), "a b");
  assert.equal(plainText("Fast &amp; Local Agents"), "Fast & Local Agents");
});

test("plainText keeps angle brackets that are not HTML tags", () => {
  assert.equal(plainText("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2");
  assert.equal(
    plainText("Agents <ship> and Vec<String>"),
    "Agents <ship> and Vec<String>",
  );
});

test("the stored rule summary is plain text", () => {
  const summary = summarize({ title: "t", body: htmlBody });
  assert.ok(!/[<>]/.test(summary));
  assert.match(summary, /^Article URL: https:\/\/x\.test\/a/);
});

test("a briefing never shows tags or entities, in any channel", () => {
  const payload = renderBriefing(
    "Rapi daily briefing",
    [
      {
        id: "1",
        title: "Holo3.1: Fast &amp; Local <b>Agents</b>",
        summary: "&lt;div class=&quot;body&quot;&gt;Merged&lt;/div&gt;",
        canonicalUrl: "https://x.test/1",
      } as never,
    ],
    { link: "https://rapi.test/b/1" },
  );
  const embed = JSON.stringify(payload.discord);
  assert.ok(!/&amp;|&lt;|<b>|<div/.test(embed + payload.text));
  assert.match(payload.text, /Holo3\.1: Fast & Local Agents/);
});

test("discordMarkdown turns a Markdown table into one bullet per row", () => {
  const table = [
    "비교:",
    "| 항목 | 값 | 비고 |",
    "|---|:---:|---|",
    "| A | 1 | 빠름 |",
    "| B | 2 |  |",
    "끝",
  ].join("\n");
  assert.equal(
    discordMarkdown(table),
    "비교:\n- **A** — 값: 1 · 비고: 빠름\n- **B** — 값: 2\n끝",
  );
  const code = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
  assert.equal(discordMarkdown(code), code);
  assert.equal(discordMarkdown("a | b\n일반 문장"), "a | b\n일반 문장");
});
