import type { ArchiveDocument, ArchiveHit } from "./chatbot.js";

export const GRAPH_ENTITY_KINDS = [
  "tool",
  "company",
  "model",
  "concept",
  "repo",
  "person",
  "other",
] as const;
export type GraphEntityKind = (typeof GRAPH_ENTITY_KINDS)[number];

export interface GraphEntityInput {
  name: string;
  kind: GraphEntityKind;
  aliases?: string[];
}

export interface GraphRelationInput {
  source: string;
  relation: string;
  target: string;
}

export interface GraphExtraction {
  entities: GraphEntityInput[];
  relations: GraphRelationInput[];
}

export interface GraphEntity {
  id: string;
  name: string;
  kind: GraphEntityKind;
  aliases: string[];
}

export interface GraphRelationRow {
  source: string;
  relation: string;
  target: string;
  documentKey: string;
}

/** Where graph facts live. The Postgres tables can be swapped for a graph database. */
export interface GraphStore {
  /** Documents never extracted, or whose title/summary changed since. */
  documentsToExtract(limit: number): Promise<ArchiveDocument[]>;
  saveExtraction(
    documentKey: string,
    extraction: GraphExtraction,
    model: string,
  ): Promise<void>;
  /** Entities whose name or alias appears in the text. */
  findEntities(text: string, limit?: number): Promise<GraphEntity[]>;
  /** Documents reachable from the entities within `depth` hops, nearest first. */
  neighborDocuments(
    entityIds: string[],
    depth: number,
    limit: number,
  ): Promise<ArchiveHit[]>;
  listEntities(limit: number): Promise<GraphEntity[]>;
  listRelations(limit: number): Promise<GraphRelationRow[]>;
}

const MAX_NAME = 80;
const MAX_ENTITIES = 12;
const MAX_RELATIONS = 16;

export const graphSlug = (name: string): string =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, "-");

/**
 * Validates a model's extraction. Entities need a known kind and a usable name;
 * a relation must connect two kept entities. Anything else is dropped, so a
 * confused model can only produce less, never invent unlinked graph nodes.
 */
export function sanitizeExtraction(value: unknown): GraphExtraction {
  const empty: GraphExtraction = { entities: [], relations: [] };
  if (!value || typeof value !== "object") return empty;
  const raw = value as { entities?: unknown; relations?: unknown };
  const entities: GraphEntityInput[] = [];
  const bySlug = new Map<string, string>();
  for (const item of Array.isArray(raw.entities) ? raw.entities : []) {
    if (!item || typeof item !== "object") continue;
    const { name, kind, aliases } = item as {
      name?: unknown;
      kind?: unknown;
      aliases?: unknown;
    };
    if (typeof name !== "string") continue;
    const clean = name.normalize("NFKC").trim().slice(0, MAX_NAME);
    const slug = graphSlug(clean);
    if (slug.length < 2 || bySlug.has(slug)) continue;
    const entityKind = GRAPH_ENTITY_KINDS.find((k) => k === kind) ?? "other";
    const cleanAliases = (Array.isArray(aliases) ? aliases : [])
      .filter((alias): alias is string => typeof alias === "string")
      .map((alias) => alias.normalize("NFKC").trim().slice(0, MAX_NAME))
      .filter((alias) => graphSlug(alias).length >= 2)
      .slice(0, 5);
    bySlug.set(slug, clean);
    entities.push({ name: clean, kind: entityKind, aliases: cleanAliases });
    if (entities.length >= MAX_ENTITIES) break;
  }
  const relations: GraphRelationInput[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.relations) ? raw.relations : []) {
    if (!item || typeof item !== "object") continue;
    const { source, relation, target } = item as Record<string, unknown>;
    if (
      typeof source !== "string" ||
      typeof relation !== "string" ||
      typeof target !== "string"
    )
      continue;
    const from = bySlug.get(graphSlug(source));
    const to = bySlug.get(graphSlug(target));
    const label = relation.normalize("NFKC").trim().slice(0, 60);
    if (!from || !to || from === to || !label) continue;
    const id = `${graphSlug(from)}|${label}|${graphSlug(to)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    relations.push({ source: from, relation: label, target: to });
    if (relations.length >= MAX_RELATIONS) break;
  }
  return { entities, relations };
}
