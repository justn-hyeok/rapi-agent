import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BrowserResearchStore, PostgresStore } from "@rapi/db";
import { RapiAgent, RecordingDeliveryAdapter } from "@rapi/agent";

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== "/rapi_test")
  throw new Error("Research E2E requires rapi_test");

test("daily browser quota is atomic, deduplicated, and remains charged on failure", async () => {
  const db = new PostgresStore(url);
  const store = new BrowserResearchStore(db);
  try {
    await db.pool.query("DELETE FROM browser_research_runs");
    const input = { ownerId: "owner", site: "x", posts: 20, dailyPosts: 30 };
    const requestId = randomUUID();
    const results = await Promise.allSettled([
      store.reserve({ ...input, requestId }),
      store.reserve({ ...input, requestId: randomUUID() }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const success = results.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<string>;
    await store.record(success.value, {
      action: "snapshot",
      viewedUrls: ["https://x.com/a/status/123"],
    });
    await store.finish(success.value, "failed");
    await assert.rejects(
      store.reserve({ ...input, requestId: randomUUID() }),
      /한도/,
    );
    const row = (
      await db.pool.query<{
        request_id: string;
        status: string;
        audit: Array<{ action: string }>;
      }>(
        "SELECT request_id,status,audit FROM browser_research_runs WHERE id=$1",
        [success.value],
      )
    ).rows[0];
    await assert.rejects(
      store.reserve({ ...input, requestId: row.request_id }),
      /이미/,
    );
    assert.equal(row.status, "failed");
    assert.equal(row.audit[0].action, "snapshot");
  } finally {
    await db.close();
  }
});

test("browser results are private aside items excluded from polling and public search", async () => {
  const db = new PostgresStore(url);
  const agent = new RapiAgent(db, new RecordingDeliveryAdapter());
  try {
    await db.resetForTests();
    const source = await agent.createSource(
      "aside",
      "browser-research:x:owner",
      "private",
      {
        ownerId: "owner",
        manualOnly: true,
      },
    );
    await agent.ingestExternalItem(source, {
      externalId: "https://x.com/a/status/123",
      url: "https://x.com/a/status/123",
      title: "ResearchPrivacyProbe",
      body: "ResearchPrivacyProbe confidential observation",
      author: null,
      publishedAt: null,
      metadata: { private: true },
    });
    assert.equal(await db.sourceVisibility(source), "private");
    assert.ok(!(await db.activeSourceIds()).includes(source));
    assert.deepEqual(await db.searchPublic("ResearchPrivacyProbe"), []);
    const row = (
      await db.pool.query<{ kind: string; owner: string; visibility: string }>(
        `SELECT s.kind,s.collection_policy->>'ownerId' AS owner,i.visibility
       FROM sources s JOIN source_items i ON i.source_id=s.id WHERE s.id=$1`,
        [source],
      )
    ).rows[0]!;
    assert.deepEqual(row, {
      kind: "aside",
      owner: "owner",
      visibility: "private",
    });
  } finally {
    await db.close();
  }
});
