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
  const start = /^ExecStart=(.+)$/m.exec(contents)?.[1].split(" ").at(-1);
  assert.equal(start, "/usr/local/lib/rapi/launch-public-gateway.mjs");
  assert.match(contents, /^ExecStartPre=$/m);
  assert.match(
    contents,
    /^Environment=RAPI_CURRENT_RELEASE=\/home\/justn\/rapi-releases\/current$/m,
  );
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

test("auto deploy runs CI-verified main without production secrets", async () => {
  const service = await unit("rapi-auto-deploy.service");
  const timer = await unit("rapi-auto-deploy.timer");
  assert.doesNotMatch(service, /^EnvironmentFile=/m);
  assert.match(service, /^User=justn$/m);
  assert.match(
    service,
    /^ExecStart=\/bin\/bash \/home\/justn\/rapi-releases\/current\/scripts\/auto-deploy\.sh$/m,
  );
  assert.match(timer, /^OnUnitInactiveSec=5min$/m);
  const script = await readFile(
    new URL("../scripts/auto-deploy.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /deploy-revision\.sh <\/dev\/null/);
  assert.match(script, /switch-release\.mjs <\/dev\/null/);
  assert.match(script, /check-runs/);
});
