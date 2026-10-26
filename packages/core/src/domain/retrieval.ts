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
 * Relevance 0-3 per candidate id from a model reply, e.g. `{"2":3,"5":1}`.
 * Ids the model invented or scores out of range are ignored, so it can only
 * rank what it was given. A reply cut off mid-way still yields the pairs that
 * arrived whole.
 */
export function parseRelevance(
  text: string,
  candidateIds: ReadonlySet<string>,
): Map<string, number> {
  const result = new Map<string, number>();
  const accept = (id: unknown, relevance: unknown) => {
    const key = typeof id === "number" ? String(id) : id;
    if (
      typeof key === "string" &&
      candidateIds.has(key) &&
      typeof relevance === "number" &&
      Number.isInteger(relevance) &&
      relevance >= 0 &&
      relevance <= 3
    )
      result.set(key, relevance);
  };
  const parsed = parseJson(text);
  if (Array.isArray(parsed)) {
    for (const row of parsed)
      if (row && typeof row === "object")
        accept(
          (row as { id?: unknown }).id,
          (row as { relevance?: unknown }).relevance,
        );
  } else if (parsed && typeof parsed === "object") {
    for (const [id, relevance] of Object.entries(parsed)) accept(id, relevance);
  } else {
    for (const match of text.matchAll(/"(\d{1,3})"\s*:\s*(\d)\b/g))
      accept(match[1], Number(match[2]));
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
