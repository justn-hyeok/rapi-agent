import {
  graphSlug,
  type ArchiveDocument,
  type ArchiveHit,
  type GraphEntity,
  type GraphEntityKind,
  type GraphExtraction,
  type GraphRelationRow,
  type GraphStore,
} from "@rapi/core";
import type { PostgresStore } from "./postgres-store.js";

interface DocumentRow {
  key: string;
  kind: ArchiveDocument["kind"];
  title: string;
  summary: string;
  url: string;
  published_at: Date;
}

interface EntityRow {
  id: string;
  name: string;
  kind: GraphEntityKind;
  aliases: string[];
}

const toEntity = (row: EntityRow): GraphEntity => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  aliases: row.aliases,
});

const MAX_QUERY_WORDS = 3;

/** Slugs of every 1-3 word run in the text, plus Hangul stems without a trailing particle. */
export function candidateSlugs(text: string): string[] {
  const words =
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 60) ?? [];
  const forms = (word: string): string[] =>
    word.length >= 3 && /\p{Script=Hangul}/u.test(word)
      ? [word, word.slice(0, -1)]
      : [word];
  const found = new Set<string>();
  for (let start = 0; start < words.length; start += 1)
    for (let size = 1; size <= MAX_QUERY_WORDS; size += 1) {
      const run = words.slice(start, start + size);
      if (run.length < size) break;
      const last = run[run.length - 1]!;
      const head = run.slice(0, -1);
      for (const form of forms(last)) {
        const slug = graphSlug([...head, form].join(" "));
        if (slug.length >= 2) found.add(slug);
      }
    }
  return [...found];
}

/** Postgres-backed graph: tables from 0031, traversal by recursive CTE. */
export class PostgresGraphStore implements GraphStore {
  constructor(private readonly db: PostgresStore) {}

  async documentsToExtract(limit: number): Promise<ArchiveDocument[]> {
    const result = await this.db.pool.query<DocumentRow>(
      `SELECT d.key,d.kind,d.title,d.summary,d.url,d.published_at
       FROM archive_documents d LEFT JOIN graph_extractions x ON x.document_key=d.key
       WHERE x.document_key IS NULL OR x.content_hash <> md5(d.title||E'\\n'||d.summary)
       ORDER BY d.published_at DESC, d.key LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      url: row.url,
      publishedAt: row.published_at,
    }));
  }

  async saveExtraction(
    documentKey: string,
    extraction: GraphExtraction,
    model: string,
  ): Promise<void> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const document = await client.query(
        "SELECT md5(title||E'\\n'||summary) AS hash FROM archive_documents WHERE key=$1 FOR SHARE",
        [documentKey],
      );
      if (!document.rowCount) {
        await client.query("ROLLBACK");
        return;
      }
      // A redone document replaces its old facts; entities themselves stay shared.
      await client.query("DELETE FROM graph_edges WHERE document_key=$1", [
        documentKey,
      ]);
      await client.query("DELETE FROM graph_mentions WHERE document_key=$1", [
        documentKey,
      ]);
      const ids = new Map<string, string>();
      for (const entity of extraction.entities) {
        const slug = graphSlug(entity.name);
        const aliases = entity.aliases ?? [];
        const saved = await client.query<{ id: string }>(
          `INSERT INTO graph_entities(id,slug,name,kind,aliases,alias_slugs)
           VALUES(gen_random_uuid(),$1,$2,$3,$4,$5)
           ON CONFLICT (slug) DO UPDATE SET
             aliases=(SELECT array(SELECT DISTINCT unnest(graph_entities.aliases||EXCLUDED.aliases))),
             alias_slugs=(SELECT array(SELECT DISTINCT unnest(graph_entities.alias_slugs||EXCLUDED.alias_slugs)))
           RETURNING id`,
          [
            slug,
            entity.name,
            entity.kind,
            aliases,
            aliases.map((alias) => graphSlug(alias)),
          ],
        );
        const id = saved.rows[0]!.id;
        ids.set(slug, id);
        await client.query(
          "INSERT INTO graph_mentions(entity_id,document_key) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [id, documentKey],
        );
      }
      for (const edge of extraction.relations) {
        const source = ids.get(graphSlug(edge.source));
        const target = ids.get(graphSlug(edge.target));
        if (!source || !target || source === target) continue;
        await client.query(
          "INSERT INTO graph_edges(source_id,relation,target_id,document_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [source, edge.relation, target, documentKey],
        );
      }
      await client.query(
        `INSERT INTO graph_extractions(document_key,content_hash,model,entity_count)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (document_key) DO UPDATE SET content_hash=EXCLUDED.content_hash,
           model=EXCLUDED.model, entity_count=EXCLUDED.entity_count, extracted_at=now()`,
        [
          documentKey,
          (document.rows[0] as { hash: string }).hash,
          model.slice(0, 100),
          extraction.entities.length,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findEntities(text: string, limit = 8): Promise<GraphEntity[]> {
    const slugs = candidateSlugs(text);
    if (!slugs.length) return [];
    const result = await this.db.pool.query<EntityRow>(
      `SELECT id,name,kind,aliases FROM graph_entities
       WHERE slug = ANY($1::text[]) OR alias_slugs && $1::text[]
       ORDER BY char_length(slug) DESC, name LIMIT $2`,
      [slugs, limit],
    );
    return result.rows.map(toEntity);
  }

  async neighborDocuments(
    entityIds: string[],
    depth: number,
    limit: number,
  ): Promise<ArchiveHit[]> {
    if (!entityIds.length) return [];
    const result = await this.db.pool.query<DocumentRow & { score: number }>(
      `WITH RECURSIVE reach(entity_id, hops) AS (
         SELECT unnest($1::uuid[]), 0
         UNION
         SELECT CASE WHEN e.source_id=r.entity_id THEN e.target_id ELSE e.source_id END, r.hops+1
         FROM reach r JOIN graph_edges e ON e.source_id=r.entity_id OR e.target_id=r.entity_id
         WHERE r.hops < $2
       ), nearest AS (
         SELECT entity_id, min(hops) AS hops FROM reach GROUP BY entity_id
       ), found AS (
         SELECT m.document_key, max(1.0/(1+n.hops)) AS score
         FROM nearest n JOIN graph_mentions m ON m.entity_id=n.entity_id
         GROUP BY m.document_key
       )
       SELECT d.key,d.kind,d.title,d.summary,d.url,d.published_at,f.score::float8 AS score
       FROM found f JOIN archive_documents d ON d.key=f.document_key
       ORDER BY f.score DESC, d.published_at DESC, d.key LIMIT $3`,
      [entityIds, Math.max(0, Math.min(depth, 3)), limit],
    );
    return result.rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      url: row.url,
      publishedAt: row.published_at,
      score: row.score,
    }));
  }

  async listEntities(limit: number): Promise<GraphEntity[]> {
    const result = await this.db.pool.query<EntityRow>(
      `SELECT e.id,e.name,e.kind,e.aliases FROM graph_entities e
       ORDER BY (SELECT count(*) FROM graph_mentions m WHERE m.entity_id=e.id) DESC, e.name LIMIT $1`,
      [limit],
    );
    return result.rows.map(toEntity);
  }

  async listRelations(limit: number): Promise<GraphRelationRow[]> {
    const result = await this.db.pool.query<{
      source: string;
      relation: string;
      target: string;
      document_key: string;
    }>(
      `SELECT s.name AS source, e.relation, t.name AS target, e.document_key
       FROM graph_edges e JOIN graph_entities s ON s.id=e.source_id
       JOIN graph_entities t ON t.id=e.target_id
       ORDER BY e.document_key, s.name LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      source: row.source,
      relation: row.relation,
      target: row.target,
      documentKey: row.document_key,
    }));
  }
}
