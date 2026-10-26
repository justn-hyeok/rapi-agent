import type { ArchiveHit } from "./chatbot.js";

/** One way to find archive documents for a question. */
export interface Retriever {
  retrieve(query: string, limit: number): Promise<ArchiveHit[]>;
}

const RRF_K = 60;

/**
 * Reciprocal rank fusion: a document ranked high in several lists beats one
 * ranked first in a single list. `weights` scale each list's contribution.
 */
export function fuseRankings(
  lists: ArchiveHit[][],
  limit: number,
  weights: number[] = [],
): ArchiveHit[] {
  const fused = new Map<string, { hit: ArchiveHit; score: number }>();
  lists.forEach((list, index) => {
    const weight = weights[index] ?? 1;
    list.forEach((hit, rank) => {
      const entry = fused.get(hit.key) ?? { hit, score: 0 };
      entry.score += weight / (RRF_K + rank + 1);
      fused.set(hit.key, entry);
    });
  });
  return [...fused.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.hit.publishedAt.getTime() - a.hit.publishedAt.getTime() ||
        a.hit.key.localeCompare(b.hit.key),
    )
    .slice(0, limit)
    .map((entry) => entry.hit);
}

const MAX_EXPANSION_TERMS = 8;

/** Keywords from a model reply; anything that is not a JSON string array yields none. */
export function parseExpansion(text: string): string[] {
  const parsed = parseJson(text);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "keywords" in parsed
      ? (parsed as { keywords: unknown }).keywords
      : null;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  for (const value of list)
    if (typeof value === "string") {
      const term = value.normalize("NFKC").trim().slice(0, 40);
      if (term) seen.add(term);
    }
  return [...seen].slice(0, MAX_EXPANSION_TERMS);
}

/**
 * Relevance 0-3 per candidate key from a model reply. Keys the model invented
 * or scored out of range are ignored, so it can only rank what it was given.
 */
export function parseRelevance(
  text: string,
  candidateKeys: ReadonlySet<string>,
): Map<string, number> {
  const parsed = parseJson(text);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "ranking" in parsed
      ? (parsed as { ranking: unknown }).ranking
      : null;
  const result = new Map<string, number>();
  if (!Array.isArray(list)) return result;
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const { key, relevance } = row as { key?: unknown; relevance?: unknown };
    if (
      typeof key === "string" &&
      candidateKeys.has(key) &&
      typeof relevance === "number" &&
      Number.isInteger(relevance) &&
      relevance >= 0 &&
      relevance <= 3
    )
      result.set(key, relevance);
  }
  return result;
}

function parseJson(text: string): unknown {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
