// Pure rules behind the community curation channels.

const KST_MS = 9 * 3_600_000;

/** "2026-10-09" for the Asia/Seoul calendar day containing `now`. */
export function kstDateKey(now: Date): string {
  return new Date(now.getTime() + KST_MS).toISOString().slice(0, 10);
}

/** Whether the Asia/Seoul clock has reached hour:minute today. */
export function kstReached(now: Date, hour: number, minute = 0): boolean {
  const local = new Date(now.getTime() + KST_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes() >= hour * 60 + minute;
}

/** 1 = Monday ... 7 = Sunday in Asia/Seoul. */
export function kstWeekday(now: Date): number {
  const day = new Date(now.getTime() + KST_MS).getUTCDay();
  return day === 0 ? 7 : day;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|ref$|source$)/.test(key)) url.searchParams.delete(key);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export interface CitationCandidate {
  id: string;
  url: string;
  title: string;
  body: string;
  source: string;
}

/**
 * Items that discuss an official post: same link, a body that links to it,
 * or a title that quotes it. An official post never cites itself.
 */
export function findCitations(
  official: { id: string; url: string; title: string },
  others: CitationCandidate[],
): CitationCandidate[] {
  const target = normalizeUrl(official.url);
  const title = official.title.trim().toLowerCase();
  return others.filter((other) => {
    if (other.id === official.id) return false;
    if (normalizeUrl(other.url) === target) return true;
    const body = other.body.toLowerCase();
    if (target.length > 12 && body.includes(target)) return true;
    if (target.length > 12 && body.includes(official.url.toLowerCase()))
      return true;
    return title.length >= 24 && other.title.toLowerCase().includes(title);
  });
}

const FREE_PATTERN =
  /\bfree\s+(?:credits?|tier|tokens?|api|models?|access|usage|trial|plan)\b|\b(?:credits?|tokens?)\s+for\s+free\b|무료\s*(?:크레딧|토큰|티어|모델|API|사용|제공|공개)|크레딧\s*(?:무료|지급|제공)/i;

/** News about free AI credits, tiers or models. */
export function isFreeTokenNews(title: string, body: string): boolean {
  return FREE_PATTERN.test(title) || FREE_PATTERN.test(body.slice(0, 600));
}

export interface OwnerRepository {
  name: string;
  fork: boolean;
  archived: boolean;
  private: boolean;
  pushedAt: string;
}

/** Public, original, recently maintained repositories worth introducing. */
export function selectProjectRepositories<T extends OwnerRepository>(
  repositories: T[],
  owner: string,
  now: Date,
  exclude: string[] = [],
): T[] {
  const skip = new Set([
    owner.toLowerCase(),
    "test",
    ...exclude.map((n) => n.toLowerCase()),
  ]);
  return repositories.filter(
    (repo) =>
      !repo.fork &&
      !repo.archived &&
      !repo.private &&
      !skip.has(repo.name.toLowerCase()) &&
      now.getTime() - Date.parse(repo.pushedAt) < 365 * 86_400_000,
  );
}
