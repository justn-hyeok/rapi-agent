import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeed } from "@rapi/adapters";

test("accepts an HTML DOCTYPE inside item CDATA content", () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><guid>1</guid><link>https://example.invalid/1</link><title>Release</title><content:encoded><![CDATA[<!DOCTYPE html><p>Body</p>]]></content:encoded></item></channel></rss>`;
  assert.equal(parseFeed(xml).length, 1);
});

test("rejects a document type declaration outside CDATA", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "y">]><rss><channel><item><guid>1</guid><title>&x;</title></item></channel></rss>`;
  assert.throws(() => parseFeed(xml), /DOCTYPE is not allowed/);
});
