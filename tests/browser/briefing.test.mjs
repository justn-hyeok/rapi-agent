import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { chromium } from "playwright";
import { renderBriefingPage } from "@rapi/core";

const batchId = "11111111-1111-4111-8111-111111111111";
const entries = [
  [
    "a",
    "Expanding the Cyber Verification Program",
    "https://www.anthropic.com/news/cyber-verification-program",
    "보안 연구 목적의 사용을 검증된 조직에 더 넓게 허용하는 프로그램 확대를 발표했다.",
    "Anthropic",
    "tools",
    "10월 6일",
    false,
  ],
  [
    "b",
    "code-yeongyu/oh-my-openagent",
    "https://github.com/code-yeongyu/oh-my-openagent",
    "oh-my-openagent(AI 에이전트 오케스트레이터, ★69859) — 5.1.22 릴리스 노트 추가, 메모리 유지관리에 영수증 원장·충돌 복구 도입, 메시지 세션에 발신자 정보 전달.",
    "팔로우 활동",
    "github",
    "활동 3건",
    true,
  ],
  [
    "c",
    "Tell HN: GitHub refuses to remove cracked copies of my software after a month of reports",
    "https://news.ycombinator.com/",
    "Photopea 개발자가 광고를 제거한 복제본 수십 개를 신고했지만 GitHub는 삭제를 거부했다.",
    "hnrss.org",
    "industry",
    "10월 7일",
    false,
  ],
  [
    "d",
    "2026년 개발자 현황",
    "https://news.hada.io/",
    "응답자 절반 가까이가 고용 불안을, 62%가 번아웃을 겪었다.",
    "news.hada.io",
    "korea",
    "10월 7일",
    false,
  ],
  [
    "e",
    "zeronsh/zeron",
    "https://github.com/zeronsh/zeron",
    "Claude Code, Codex, Cursor, Devin 등 여러 코딩 에이전트를 한곳에서 다루는 네이티브 제어판.",
    "GitHub 추천",
    "github",
    "★3,073",
    true,
  ],
].map(([id, title, url, summary, source, section, meta, repository]) => ({
  id: `${id.repeat(8)}-${id.repeat(4)}-4${id.repeat(3)}-8${id.repeat(3)}-${id.repeat(12)}`,
  title,
  url,
  summary,
  source,
  section,
  meta,
  repository,
  ...(id === "e"
    ? { why: "devswha가 최근 star · 관심 topic: claude-code, codex" }
    : {}),
  feedback: { up: false, down: false, save: false },
}));

test(
  "briefing page works at phone and desktop widths in both themes",
  { timeout: 60_000 },
  async () => {
    const posts = [];
    let failNext = false;
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url.startsWith(`/b/${batchId}`)) {
        const page = renderBriefingPage({
          batchId,
          token: "1.t",
          dateLabel: "2026년 10월 8일 수요일",
          entries,
        });
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; style-src 'nonce-${page.nonce}'; script-src 'nonce-${page.nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
        return response.end(page.html);
      }
      if (
        request.method === "POST" &&
        request.url === `/b/${batchId}/feedback`
      ) {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          posts.push(JSON.parse(body));
          response.writeHead(failNext ? 500 : 200, {
            "content-type": "application/json",
          });
          failNext = false;
          response.end("{}");
        });
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      for (const [width, height] of [
        [390, 844],
        [1280, 900],
      ])
        for (const colorScheme of ["light", "dark"]) {
          const page = await browser.newPage({
            viewport: { width, height },
            colorScheme,
          });
          const problems = [];
          page.on("console", (message) => {
            if (message.type() === "error") problems.push(message.text());
          });
          page.on("pageerror", (error) => problems.push(error.message));
          await page.goto(`${origin}/b/${batchId}?t=1.t`);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          assert.ok(
            overflow <= 0,
            `horizontal overflow ${overflow}px at ${width}`,
          );
          for (const box of await page
            .locator(".act")
            .evaluateAll((nodes) =>
              nodes.map((n) => n.getBoundingClientRect().height),
            ))
            assert.ok(box >= 36, `action target ${box}px`);
          const bg = await page.evaluate(
            () => getComputedStyle(document.body).backgroundColor,
          );
          assert.equal(
            bg,
            colorScheme === "dark" ? "rgb(23, 27, 24)" : "rgb(250, 249, 245)",
          );
          if (process.env.RAPI_SCREENSHOT_DIR)
            await page.screenshot({
              path: join(
                process.env.RAPI_SCREENSHOT_DIR,
                `briefing-${width}-${colorScheme}.png`,
              ),
              fullPage: true,
            });
          assert.deepEqual(problems, []);
          await page.close();
        }

      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.goto(`${origin}/b/${batchId}?t=1.t`);
      const first = page.locator(".item").first();
      await first.locator('[data-k="up"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('.item [data-k="up"]')
            .getAttribute("aria-pressed") === "true",
      );
      await first.locator('[data-k="down"]').click();
      assert.equal(
        await first.locator('[data-k="up"]').getAttribute("aria-pressed"),
        "false",
      );
      assert.equal(
        await first.locator('[data-k="down"]').getAttribute("aria-pressed"),
        "true",
      );
      await first.locator('[data-k="save"]').click();
      assert.equal(await page.locator("#saved-n").textContent(), "1");
      await page.locator("#t-saved").click();
      assert.equal(await page.locator(".item:not([hidden])").count(), 1);
      await page.locator("#t-brief").click();
      await page.locator('.chip[data-section="github"]').click();
      assert.equal(await page.locator(".item:not([hidden])").count(), 2);
      await page.locator('.chip[data-section="all"]').click();

      failNext = true;
      const second = page.locator(".item").nth(1);
      await second.locator('[data-k="up"]').click();
      await page.locator("#note:not([hidden])").waitFor();
      assert.equal(
        await second.locator('[data-k="up"]').getAttribute("aria-pressed"),
        "false",
      );
      await page.waitForTimeout(200);
      assert.deepEqual(
        posts.slice(0, 3).map((p) => [p.kind, p.on, p.t]),
        [
          ["up", true, "1.t"],
          ["down", true, "1.t"],
          ["save", true, "1.t"],
        ],
      );
    } finally {
      await browser.close();
      server.close();
    }
  },
);
