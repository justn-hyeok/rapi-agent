import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function unit(name: string): Promise<string> {
  return readFile(new URL(`../ops/systemd/${name}`, import.meta.url), "utf8");
}

test("withdrawal preflight checks the same sealed release the gateway starts", async () => {
  const contents = await unit(
    "rapi-public-gateway.service.d/20-source-expiry.conf",
  );
  const root = /^WorkingDirectory=(.+)$/m.exec(contents)?.[1];
  const start = /^ExecStart=(.+)$/m.exec(contents)?.[1].split(" ").at(-1);
  const check = /^ExecStartPre=(.+)$/m.exec(contents)?.[1].split(" ").at(-1);
  assert.equal(start, `${root}/ops/gateway/run.mjs`);
  assert.equal(check, `${root}/scripts/check-withdrawal-support.mjs`);
  assert.match(contents, /^ExecStart=$/m);
  assert.match(contents, /^Environment=RAPI_BLOG_WITHDRAWALS_REQUIRED=true$/m);
});

test("Discord Gateway startup is isolated from the HTTP bot lifecycle", async () => {
  const chat = await unit("rapi-chat.service");

  assert.doesNotMatch(chat, /^Requires=rapi-bot\.service$/m);
  assert.doesNotMatch(chat, /^After=.*rapi-bot\.service/m);
});

test("Discord services cap persistent crash restart loops", async () => {
  for (const name of ["rapi-bot.service", "rapi-chat.service"]) {
    const contents = await unit(name);
    assert.match(contents, /^StartLimitIntervalSec=10min$/m, name);
    assert.match(contents, /^StartLimitBurst=10$/m, name);
    assert.match(contents, /^RestartSec=30$/m, name);
  }
});

test("HTTP bot startup does not require the optional runtime socket path", async () => {
  const bot = await unit("rapi-bot.service");

  assert.doesNotMatch(bot, /^ReadWritePaths=.*\/run\/rapi-public-agent/m);
});
