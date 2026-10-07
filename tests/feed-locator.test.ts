import assert from "node:assert/strict";
import { test } from "node:test";
import { redactUrlTokens, resolveFeedLocator } from "@rapi/agent";

test("resolves env feed locators from the service environment only", () => {
  const environment = {
    GITHUB_PRIVATE_FEED_URL: "https://github.com/me.private.atom?token=abc",
  };
  assert.equal(
    resolveFeedLocator("env:GITHUB_PRIVATE_FEED_URL", environment),
    environment.GITHUB_PRIVATE_FEED_URL,
  );
  assert.equal(
    resolveFeedLocator("https://example.com/feed", environment),
    "https://example.com/feed",
  );
  assert.throws(() => resolveFeedLocator("env:DATABASE_URL", environment));
  assert.throws(() => resolveFeedLocator("env:MISSING_FEED_URL", environment));
});

test("redacts URL tokens before raw payloads are stored", () => {
  assert.equal(
    redactUrlTokens(
      '<link href="https://github.com/me.private.atom?token=abc123"/><a href="/x?a=1&access_token=zz">',
    ),
    '<link href="https://github.com/me.private.atom?token=REDACTED"/><a href="/x?a=1&access_token=REDACTED">',
  );
});
