import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelClient } from "@rapi/adapters";
import { GraphExtractor, GraphIndexer, GraphRetriever } from "@rapi/agent";
import { candidateSlugs } from "@rapi/db";
import {
  graphSlug,
  sanitizeExtraction,
  type ArchiveDocument,
  type ArchiveHit,
  type GraphEntity,
  type GraphExtraction,
  type GraphStore,
} from "@rapi/core";

const document = (key: string): ArchiveDocument => ({
  key,
  kind: "blog",
  title: `제목 ${key}`,
  summary: "요약",
  url: `https://rapi.example/${key}`,
  publishedAt: new Date("2026-10-01T00:00:00Z"),
});

const reply = (text: string): ModelClient => ({
  async complete() {
    return {
      text,
      model: "fake",
      usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 0 },
    };
  },
});

test("extraction keeps only linked, bounded, well-formed facts", () => {
  const out = sanitizeExtraction({
    entities: [
      { name: "Cursor", kind: "tool", aliases: ["커서", "x", 5] },
      { name: "cursor", kind: "tool" },
      { name: "Anthropic", kind: "company" },
      { name: "?", kind: "tool" },
      { name: "Mystery", kind: "not-a-kind" },
      "junk",
    ],
    relations: [
      { source: "cursor", relation: "built on", target: "Anthropic" },
      { source: "Cursor", relation: "built on", target: "Anthropic" },
      { source: "Cursor", relation: "uses", target: "Ghost" },
      { source: "Cursor", relation: "", target: "Anthropic" },
      { source: "Cursor", relation: "is", target: "Cursor" },
    ],
  });
  assert.deepEqual(
    out.entities.map((e) => [e.name, e.kind]),
    [
      ["Cursor", "tool"],
      ["Anthropic", "company"],
      ["Mystery", "other"],
    ],
  );
  assert.deepEqual(out.entities[0]!.aliases, ["커서"]);
  assert.deepEqual(out.relations, [
    { source: "Cursor", relation: "built on", target: "Anthropic" },
  ]);
  assert.deepEqual(sanitizeExtraction(null), { entities: [], relations: [] });
  assert.equal(graphSlug("Claude  Code!"), "claude-code");
});

test("question words map to entity slugs, with Hangul particles stripped", () => {
  const slugs = candidateSlugs("커서를 Claude Code랑 비교해줘");
  for (const expected of ["커서", "claude-code", "claude"])
    assert.ok(slugs.includes(expected), expected);
  assert.deepEqual(candidateSlugs("?!"), []);
});

class FakeGraphStore implements GraphStore {
  saved: { key: string; extraction: GraphExtraction }[] = [];
  constructor(
    private readonly pending: ArchiveDocument[],
    private readonly entities: GraphEntity[] = [],
    private readonly neighbors: ArchiveHit[] = [],
  ) {}
  async documentsToExtract(limit: number) {
    return this.pending.slice(0, limit);
  }
  async saveExtraction(key: string, extraction: GraphExtraction) {
    this.saved.push({ key, extraction });
  }
  async findEntities() {
    return this.entities;
  }
  async neighborDocuments(_ids: string[], _depth: number, limit: number) {
    return this.neighbors.slice(0, limit);
  }
  async listEntities() {
    return [];
  }
  async listRelations() {
    return [];
  }
}

test("the indexer extracts one batch and records documents with no entities", async () => {
  const store = new FakeGraphStore([
    document("a"),
    document("b"),
    document("c"),
  ]);
  const indexer = new GraphIndexer(
    store,
    new GraphExtractor(
      reply('```json\n{"entities":[{"name":"Cursor","kind":"tool"}]}\n```'),
    ),
    { batchSize: 2 },
  );
  assert.deepEqual(await indexer.runDue(), { extracted: 2, failed: 0 });
  assert.deepEqual(
    store.saved.map((s) => s.key),
    ["a", "b"],
  );
  const empty = new FakeGraphStore([document("z")]);
  await new GraphIndexer(empty, new GraphExtractor(reply("sorry"))).runDue();
  assert.deepEqual(empty.saved[0]!.extraction, { entities: [], relations: [] });
});

test("the indexer gives up after repeated model failures and keeps going otherwise", async () => {
  const store = new FakeGraphStore(
    ["a", "b", "c", "d", "e"].map((key) => document(key)),
  );
  const result = await new GraphIndexer(
    store,
    new GraphExtractor({
      async complete() {
        throw new Error("monthly model budget reached");
      },
    }),
  ).runDue();
  assert.deepEqual(result, { extracted: 0, failed: 3 });
  assert.equal(store.saved.length, 0);
});

test("the graph retriever only searches when the question names a known entity", async () => {
  const neighbor: ArchiveHit = { ...document("n"), score: 0.5 };
  const none = new GraphRetriever(new FakeGraphStore([], [], [neighbor]));
  assert.deepEqual(await none.retrieve("아무 말", 5), []);
  const some = new GraphRetriever(
    new FakeGraphStore(
      [],
      [{ id: "e1", name: "Cursor", kind: "tool", aliases: [] }],
      [neighbor],
    ),
  );
  // Entity mentions count for half a keyword match, so neighbours stay "nearest" posts.
  assert.deepEqual(await some.retrieve("커서", 5), [
    { ...neighbor, score: 0.25 },
  ]);
});
