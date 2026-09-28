import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { once } from "node:events";
import { FeedSourceAdapter, type SourcePayload } from "@rapi/adapters";

test("source deadlines cover both headers and body, and preserve malformed raw responses", async () => {
  const xml =
    "<rss><channel><item><guid>1</guid><link>https://example.invalid/1</link><title>Release</title></item></channel></rss>";
  const server = createServer((req, res) => {
    if (req.url === "/headers") return;
    if (req.url === "/body") {
      res.writeHead(200);
      res.write("<rss>");
      return;
    }
    if (req.url === "/oversize") {
      res.end("x".repeat(1000));
      return;
    }
    res.end(req.url === "/invalid" ? "not a feed" : xml);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const adapter = new FeedSourceAdapter({ timeoutMs: 150, maxBodyBytes: 500 });
  try {
    const results = await Promise.allSettled([
      adapter.fetch(`${base}/headers`),
      adapter.fetch(`${base}/body`),
      adapter.fetch(`${base}/valid`),
    ]);
    assert.equal(results[0]!.status, "rejected");
    assert.equal(results[1]!.status, "rejected");
    assert.equal(results[2]!.status, "fulfilled");
    await assert.rejects(adapter.fetch(`${base}/oversize`), /byte limit/);
    const raw: SourcePayload[] = [];
    await assert.rejects(
      adapter.fetch(`${base}/invalid`, undefined, async (payload) => {
        raw.push(payload);
      }),
      /Unsupported/,
    );
    assert.equal(raw[0]?.body, "not a feed");
    await assert.rejects(
      adapter.fetch(`${base}/valid`, undefined, async () => {
        throw new Error("raw persistence failed");
      }),
      /raw persistence failed/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
