import { createHmac, timingSafeEqual } from "node:crypto";

export const LEARNER_LINK_DAYS = 60;
export const LEARNER_ISSUE_ITEM_LIMIT = 8;
export const LEARNER_CADENCES = ["daily", "weekly"] as const;
export type LearnerCadence = (typeof LEARNER_CADENCES)[number];

export function isLearnerCadence(value: unknown): value is LearnerCadence {
  return value === "daily" || value === "weekly";
}

/** Domain-separated key so the click-link signature never reuses another secret's role. */
export function learnerLinkKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("rapi-learner-link-v1").digest();
}

function signature(
  key: Buffer,
  itemId: string,
  userId: string,
  expires: number,
): string {
  return createHmac("sha256", key)
    .update(`${itemId}.${userId}.${expires}`)
    .digest("base64url");
}

/** The token names an issue item and a recipient; the target URL is never in it. */
export function signLearnerLink(
  key: Buffer,
  itemId: string,
  userId: string,
  now = new Date(),
): string {
  const expires = Math.floor(now.getTime() / 1000) + LEARNER_LINK_DAYS * 86400;
  return `${itemId}.${userId}.${expires}.${signature(key, itemId, userId, expires)}`;
}

export function verifyLearnerLink(
  key: Buffer,
  token: string,
  now = new Date(),
): { itemId: string; userId: string } | null {
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{15,20})\.(\d{10})\.([\w-]{43})$/.exec(
      token,
    );
  if (!match) return null;
  const [, itemId, userId, expiresText, given] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const expires = Number(expiresText);
  if (expires * 1000 < now.getTime()) return null;
  const expected = Buffer.from(signature(key, itemId, userId, expires));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  return { itemId, userId };
}

const KST_OFFSET_MS = 9 * 3_600_000;

/**
 * The latest scheduled boundary at or before `now`, in Asia/Seoul wall time:
 * every day at `hour`, or only on `weekday` (0 = Sunday) when given.
 * `key` is the boundary's Seoul calendar date.
 */
function latestBoundary(
  now: Date,
  hour: number,
  weekday?: number,
): { key: string; at: Date } {
  const seoul = new Date(now.getTime() + KST_OFFSET_MS);
  let wall = Date.UTC(
    seoul.getUTCFullYear(),
    seoul.getUTCMonth(),
    seoul.getUTCDate(),
    hour,
  );
  if (wall > seoul.getTime()) wall -= 86_400_000;
  if (weekday !== undefined)
    wall -= ((new Date(wall).getUTCDay() - weekday + 7) % 7) * 86_400_000;
  return {
    key: new Date(wall).toISOString().slice(0, 10),
    at: new Date(wall - KST_OFFSET_MS),
  };
}

/** Daily issues are due at 09:00 Asia/Seoul, weekly ones on Monday 09:00. */
export function learnerIssueBoundary(cadence: LearnerCadence, now: Date) {
  return cadence === "daily"
    ? latestBoundary(now, 9)
    : latestBoundary(now, 9, 1);
}

/** The weekly report is due on Monday 10:00 Asia/Seoul. */
export function learnerReportBoundary(now: Date) {
  return latestBoundary(now, 10, 1);
}

export type LearnerSection = "core" | "tools";

export const LEARNER_SECTIONS: Array<{ id: LearnerSection; label: string }> = [
  { id: "core", label: "핵심" },
  { id: "tools", label: "도구 입문" },
];

export interface LearnerPost {
  key: string;
  feed: string;
  title: string | null;
  embeds: unknown;
  data: unknown;
}

export interface LearnerItemDraft {
  postKey: string;
  section: LearnerSection;
  title: string;
  summary: string;
  url: string;
}

/** Only plain https links without credentials may ever be redirect targets. */
export function safeLearnerUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Reads a curated post as a learner item; posts without a usable link yield null. */
export function learnerItemFromPost(
  post: LearnerPost,
): LearnerItemDraft | null {
  const section: LearnerSection =
    post.feed === "free-tokens" ? "core" : "tools";
  const embeds = Array.isArray(post.embeds) ? post.embeds : [];
  for (const raw of embeds) {
    if (!raw || typeof raw !== "object") continue;
    const embed = raw as {
      title?: unknown;
      url?: unknown;
      description?: unknown;
    };
    const description =
      typeof embed.description === "string" ? embed.description : "";
    const url =
      safeLearnerUrl(embed.url) ??
      safeLearnerUrl(/https:\/\/[^\s)<>\]]+/.exec(description)?.[0]);
    const title =
      typeof embed.title === "string" && embed.title.trim()
        ? embed.title.trim()
        : (post.title?.trim() ?? "");
    if (!url || !title) continue;
    return {
      postKey: post.key,
      section,
      title: title.slice(0, 120),
      summary: description
        .replace(/https:\/\/[^\s)<>\]]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160),
      url,
    };
  }
  return null;
}

/** Core items first, newest first within a section, capped. */
export function selectLearnerItems(
  items: LearnerItemDraft[],
  limit = LEARNER_ISSUE_ITEM_LIMIT,
): LearnerItemDraft[] {
  const order = new Map(LEARNER_SECTIONS.map((s, index) => [s.id, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        order.get(a.item.section)! - order.get(b.item.section)! ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

export interface LearnerMetrics {
  activeSubscribers: number;
  weeklyClickers: number;
  replies: number;
  optOuts: number;
  emailYes: number;
  emailNo: number;
}

export interface LearnerVerdict {
  status: "success" | "stop" | "in_progress";
  label: string;
  action: string;
  clickRate: number | null;
  emailBranch: string | null;
}

/** Phase-0 judgement from docs/product-direction.md; replies and opt-outs are experiment totals. */
export function learnerVerdict(metrics: LearnerMetrics): LearnerVerdict {
  const clickRate =
    metrics.activeSubscribers > 0
      ? metrics.weeklyClickers / metrics.activeSubscribers
      : null;
  const answered = metrics.emailYes + metrics.emailNo;
  const emailBranch =
    answered > 0 && metrics.emailYes * 2 < answered
      ? "1단계에서 메일 제외"
      : null;
  const stop = metrics.optOuts >= 2 || (clickRate !== null && clickRate < 0.1);
  if (stop)
    return {
      status: "stop",
      label: "중단",
      action: "학습자 트랙 재설계",
      clickRate,
      emailBranch,
    };
  if (
    clickRate !== null &&
    clickRate >= 0.3 &&
    metrics.replies >= 2 &&
    metrics.optOuts <= 1
  )
    return {
      status: "success",
      label: "성공",
      action: "1단계 진행",
      clickRate,
      emailBranch,
    };
  return {
    status: "in_progress",
    label: "진행 중",
    action: "계속 측정",
    clickRate,
    emailBranch,
  };
}
