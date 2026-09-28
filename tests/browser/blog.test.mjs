import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { chromium } from "playwright";

test(
  "public blog navigation and narrow layouts work through the gateway",
  { timeout: 45_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rapi-blog-withdrawal-"));
    const withdrawalsFile = join(directory, "withdrawals.json");
    await writeFile(withdrawalsFile, JSON.stringify({ version: 1, slugs: [] }));
    const gateway = spawn(process.execPath, ["ops/gateway/run.mjs"], {
      env: {
        PATH: process.env.PATH,
        RAPI_GATEWAY_PORT: "0",
        RAPI_GATEWAY_HEALTH_PORT: "0",
        PORT: "1",
        RAPI_PUBLIC_BASE_URL: "https://rotated.example",
        RAPI_BLOG_WITHDRAWALS_FILE: withdrawalsFile,
        RAPI_BLOG_WITHDRAWALS_REQUIRED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let browser;
    try {
      const origin = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Gateway startup timed out")),
          10_000,
        );
        gateway.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        gateway.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("Gateway exited before startup"));
        });
        gateway.stdout.on("data", (chunk) => {
          const match = /listening on (127\.0\.0\.1:\d+)/.exec(
            chunk.toString(),
          );
          if (match) {
            clearTimeout(timeout);
            resolve(`http://${match[1]}`);
          }
        });
      });
      browser = await chromium.launch({ headless: true });
      await mkdir("docs/evidence/blog-browser", { recursive: true });
      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
      ]) {
        const context = await browser.newContext({ viewport });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const response = await page.goto(`${origin}/blog/`);
          assert.equal(response.status(), 200);
          assert.equal(
            await page.getByRole("heading", { level: 1 }).textContent(),
            "질문에서 시작한 기록.",
          );
          await page.getByRole("link", { name: "라피 사용 안내" }).click();
          assert.match(page.url(), /rapi-start\.html$/);
          assert.equal(
            await page.getByRole("heading", { level: 1 }).textContent(),
            "라피 사용 안내",
          );
          assert(
            await page.evaluate(
              () =>
                globalThis.document.documentElement.scrollWidth <=
                globalThis.innerWidth,
            ),
          );
          assert.equal(
            await page
              .getByRole("link", { name: "Discord 커뮤니티에 참여하기" })
              .getAttribute("href"),
            "https://discord.gg/DVbb9uwu8V",
          );
          await page.screenshot({
            path: `docs/evidence/blog-browser/${viewport.width}.png`,
            fullPage: true,
          });
          await page.getByRole("link", { name: "라피 / 기록" }).click();
          assert.match(page.url(), /\/blog\/$/);
          assert.deepEqual(errors, []);
          assert.match(
            await (await context.request.get(`${origin}/blog/feed.xml`)).text(),
            /https:\/\/rotated.example\/blog\/rapi-start.html/,
          );
          assert.equal(
            (await context.request.get(`${origin}/ready`)).status(),
            404,
          );
          assert.equal(
            (await context.request.get(`${origin}/blog/../.env`)).status(),
            404,
          );
        } finally {
          await context.close();
        }
      }
      const context = await browser.newContext();
      try {
        await writeFile(
          withdrawalsFile,
          JSON.stringify({ version: 1, slugs: ["rapi-start"] }),
        );
        assert.equal(
          (
            await context.request.get(`${origin}/blog/rapi-start.html`)
          ).status(),
          404,
        );
        const page = await context.newPage();
        assert.equal((await page.goto(`${origin}/blog/`)).status(), 200);
        assert.equal(
          await page.getByRole("link", { name: "라피 사용 안내" }).count(),
          0,
        );
        assert(
          !(
            await (await context.request.get(`${origin}/blog/feed.xml`)).text()
          ).includes("rapi-start.html"),
        );
        await writeFile(withdrawalsFile, "invalid withdrawal state");
        assert.equal(
          (await context.request.get(`${origin}/blog/`)).status(),
          404,
        );
        assert.equal(
          (await context.request.get(`${origin}/blog/feed.xml`)).status(),
          404,
        );
      } finally {
        await context.close();
      }
    } finally {
      await browser?.close();
      if (gateway.exitCode === null && gateway.signalCode === null) {
        const exited = once(gateway, "exit");
        gateway.kill("SIGTERM");
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
