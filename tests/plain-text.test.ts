import assert from "node:assert/strict";
import { test } from "node:test";
import { plainText, renderBriefing, summarize } from "@rapi/core";

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

test("plainText keeps a bare angle bracket that is not a tag", () => {
  assert.equal(plainText("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2");
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
