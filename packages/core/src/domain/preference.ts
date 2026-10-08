// Personal ranking learned from the owner's reactions on briefing pages.
// Deliberately simple and explainable: per-source and per-title-term weights.

export interface FeedbackSignal {
  sourceId: string;
  title: string;
  kind: "up" | "down" | "save" | "open";
}

export interface Preferences {
  sources: Map<string, number>;
  terms: Map<string, number>;
}

const WEIGHTS = { up: 1, save: 1.5, open: 0.3, down: -1.5 } as const;
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "your",
  "you",
  "how",
  "what",
  "why",
  "new",
  "into",
  "are",
  "was",
  "this",
  "that",
  "its",
  "our",
  "via",
  "using",
  "about",
  "release",
  "github",
  "show",
  "tell",
  "ask",
  "now",
  "can",
  "will",
  "has",
  "have",
  "not",
  "more",
  "all",
  "그리고",
  "위한",
  "대한",
  "에서",
  "으로",
  "하는",
  "있는",
  "활동",
  "추천",
]);

export function titleTerms(title: string): string[] {
  const words =
    title.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [];
  const terms = words
    .map((word) => word.replace(/[.-]+$/, ""))
    .filter((word) => {
      if (STOPWORDS.has(word) || /^\d+$/.test(word)) return false;
      return /[가-힣]/.test(word) ? word.length >= 2 : word.length >= 3;
    });
  return [...new Set(terms)];
}

export function learnPreferences(signals: FeedbackSignal[]): Preferences {
  const sources = new Map<string, number>();
  const terms = new Map<string, number>();
  for (const signal of signals) {
    const weight = WEIGHTS[signal.kind];
    sources.set(signal.sourceId, (sources.get(signal.sourceId) ?? 0) + weight);
    const words = titleTerms(signal.title);
    // A long title should not outvote a short one.
    const share = words.length ? weight / Math.sqrt(words.length) : 0;
    for (const word of words) terms.set(word, (terms.get(word) ?? 0) + share);
  }
  return { sources, terms };
}

const clamp = (value: number, limit: number) =>
  Math.max(-limit, Math.min(limit, value));

export function preferenceScore(
  candidate: { sourceId: string; title: string },
  preferences: Preferences,
): { score: number; reason?: string } {
  const source = clamp(preferences.sources.get(candidate.sourceId) ?? 0, 3);
  let termTotal = 0;
  let best: { term: string; weight: number } | undefined;
  for (const term of titleTerms(candidate.title)) {
    const weight = preferences.terms.get(term);
    if (weight === undefined) continue;
    termTotal += weight;
    if (!best || weight > best.weight) best = { term, weight };
  }
  const score = source * 0.4 + clamp(termTotal, 3) * 0.6;
  const reason =
    best && best.weight >= 0.9
      ? `좋아요 누른 '${best.term}' 관련`
      : source >= 2
        ? "자주 반응한 출처"
        : undefined;
  return reason ? { score, reason } : { score };
}

/**
 * Re-orders recency-sorted candidates by learned preference. Recency stays a
 * gentle tiebreaker so a strong preference can lift an older item a few places.
 */
export function rankByPreference<T>(
  rows: readonly T[],
  preferences: Preferences,
  key: (row: T) => { sourceId: string; title: string },
): T[] {
  if (!preferences.sources.size && !preferences.terms.size) return [...rows];
  return rows
    .map((row, index) => ({
      row,
      value: preferenceScore(key(row), preferences).score - index * 0.02,
    }))
    .sort((a, b) => b.value - a.value)
    .map(({ row }) => row);
}
