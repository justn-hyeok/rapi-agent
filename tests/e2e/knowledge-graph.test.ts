import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresGraphStore, PostgresStore } from "@rapi/db";

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== "/rapi_test")
  throw new Error("Graph E2E requires rapi_test");

async function insertDocument(
  db: PostgresStore,
  key: string,
  title: string,
  summary: string,
) {
  await db.pool.query(
    `INSERT INTO archive_documents(key,kind,title,summary,url,published_at)
     VALUES($1,'blog',$2,$3,$4,now())
     ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary`,
    [key, title, summary, `https://rapi.example/${key}`],
  );
}

test("graph facts are saved per document, redone on change, found by entity, and cascade away", async () => {
  const db = new PostgresStore(url);
  const graph = new PostgresGraphStore(db);
  try {
    await db.pool.query("DELETE FROM graph_entities");
    await db.pool.query("DELETE FROM archive_documents WHERE key LIKE 'g:%'");
    await insertDocument(
      db,
      "g:1",
      "Cursor 소개",
      "Cursor는 Claude 위에서 동작",
    );
    await insertDocument(db, "g:2", "Claude 소식", "Anthropic이 Claude를 발표");
    await insertDocument(db, "g:3", "Anthropic 채용", "Anthropic 회사 소식");

    const pending = (await graph.documentsToExtract(10)).map((d) => d.key);
    for (const key of ["g:1", "g:2", "g:3"]) assert.ok(pending.includes(key));

    await graph.saveExtraction(
      "g:1",
      {
        entities: [
          { name: "Cursor", kind: "tool", aliases: ["커서"] },
          { name: "Claude", kind: "model" },
        ],
        relations: [
          { source: "Cursor", relation: "built on", target: "Claude" },
        ],
      },
      "fake",
    );
    await graph.saveExtraction(
      "g:2",
      {
        entities: [
          { name: "Anthropic", kind: "company" },
          { name: "claude", kind: "model" },
        ],
        relations: [
          { source: "Anthropic", relation: "released", target: "claude" },
        ],
      },
      "fake",
    );
    await graph.saveExtraction(
      "g:3",
      { entities: [{ name: "Anthropic", kind: "company" }], relations: [] },
      "fake",
    );
    assert.ok(
      !(await graph.documentsToExtract(50)).some((d) => d.key.startsWith("g:")),
    );

    // Same entity from two posts is one node.
    const entities = await graph.listEntities(50);
    assert.equal(
      entities.filter((e) => e.name.toLowerCase() === "claude").length,
      1,
    );

    // A particle-bearing alias still finds the entity.
    const found = await graph.findEntities("커서를 쓰는 법");
    assert.deepEqual(
      found.map((e) => e.name),
      ["Cursor"],
    );

    // One hop: posts mentioning Cursor or its direct neighbour (Claude).
    const hop1 = (await graph.neighborDocuments([found[0]!.id], 1, 10)).map(
      (h) => h.key,
    );
    assert.deepEqual(hop1.sort(), ["g:1", "g:2"]);
    // Two hops reaches Anthropic's other post.
    const hop2 = await graph.neighborDocuments([found[0]!.id], 2, 10);
    assert.deepEqual(hop2.map((h) => h.key).sort(), ["g:1", "g:2", "g:3"]);
    assert.equal(hop2[0]!.key, "g:1");
    assert.ok(hop2[0]!.score > hop2.at(-1)!.score);
    assert.deepEqual(await graph.neighborDocuments([], 2, 10), []);

    // Editing a post makes it pending again; redoing it replaces its old edge.
    await insertDocument(db, "g:1", "Cursor 소개", "내용이 바뀌었어요");
    assert.ok(
      (await graph.documentsToExtract(50)).some((d) => d.key === "g:1"),
    );
    await graph.saveExtraction(
      "g:1",
      { entities: [{ name: "Cursor", kind: "tool" }], relations: [] },
      "fake",
    );
    assert.ok(
      !(await graph.listRelations(50)).some((r) => r.relation === "built on"),
    );

    // A missing document is ignored; deleting a document removes its facts.
    await graph.saveExtraction(
      "g:missing",
      { entities: [{ name: "Ghost", kind: "other" }], relations: [] },
      "fake",
    );
    assert.ok(!(await graph.listEntities(50)).some((e) => e.name === "Ghost"));
    await db.pool.query("DELETE FROM archive_documents WHERE key='g:2'");
    assert.ok(
      !(await graph.listRelations(50)).some((r) => r.documentKey === "g:2"),
    );
  } finally {
    await db.pool.query("DELETE FROM graph_entities");
    await db.pool.query("DELETE FROM archive_documents WHERE key LIKE 'g:%'");
    await db.close();
  }
});
