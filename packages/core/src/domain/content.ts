import { createHash } from "node:crypto";
import type {
  BriefingItem,
  DeliveryPayload,
  NormalizedItem,
  Visibility,
} from "./models.js";

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only HTTP(S) source URLs are allowed");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function contentFingerprint(title: string, body: string): string {
  const normalized = `${title}\n${body}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function checksumPayload(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const taxonomy: Readonly<Record<string, readonly string[]>> = {
  security: ["security", "vulnerability", "cve", "보안", "취약점"],
  release: ["release", "released", "version", "출시", "버전"],
  development: ["pull request", "commit", "issue", "github", "개발"],
  ai: ["ai", "model", "llm", "인공지능", "모델"],
};

export function classify(title: string, body: string): string[] {
  const haystack = `${title} ${body}`.toLowerCase();
  const labels = Object.entries(taxonomy)
    .filter(([, words]) => words.some((word) => haystack.includes(word)))
    .map(([label]) => label);
  return labels.length > 0 ? labels : ["general"];
}

export function summarize(
  item: Pick<NormalizedItem, "title" | "body">,
): string {
  const clean = item.body.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return item.title;
  return clean.length <= 220 ? clean : `${clean.slice(0, 217)}...`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

export function renderBriefing(
  title: string,
  items: BriefingItem[],
): DeliveryPayload {
  const textLines = [title, ""];
  const htmlItems: string[] = [];
  for (const item of items) {
    textLines.push(
      `- ${item.title}`,
      `  ${item.summary}`,
      `  ${item.canonicalUrl}`,
      "",
    );
    htmlItems.push(
      `<li><a href="${escapeHtml(item.canonicalUrl)}">${escapeHtml(item.title)}</a><p>${escapeHtml(item.summary)}</p></li>`,
    );
  }
  return {
    subject: title,
    text: textLines.join("\n").trimEnd(),
    html: `<!doctype html><html><body><h1>${escapeHtml(title)}</h1><ul>${htmlItems.join("")}</ul></body></html>`,
    itemIds: items.map((item) => item.id),
  };
}

export function splitDiscordMessage(message: string, limit = 1900): string[] {
  if (message.length <= limit) return [message];
  const chunks: string[] = [];
  let remaining = message;
  while (remaining.length > limit) {
    const splitAt = Math.max(
      remaining.lastIndexOf("\n", limit),
      remaining.lastIndexOf(" ", limit),
    );
    const index = splitAt > 0 ? splitAt : limit;
    chunks.push(remaining.slice(0, index).trimEnd());
    remaining = remaining.slice(index).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function assertPublishable(
  items: BriefingItem[],
  requested: Visibility,
): void {
  if (
    requested === "public" &&
    items.some((item) => item.visibility !== "public")
  ) {
    throw new Error(
      "Private or unlisted source items cannot be included in a public publication",
    );
  }
}

export function renderMdx(
  slug: string,
  title: string,
  visibility: Visibility,
  items: BriefingItem[],
  generatedAt: Date,
): string {
  assertPublishable(items, visibility);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `slug: ${JSON.stringify(slug)}`,
    `visibility: ${visibility}`,
    `generatedAt: ${generatedAt.toISOString()}`,
    "---",
    "",
  ];
  const body = items.flatMap((item) => [
    `## [${item.title.replace(/[[\]]/g, "")}](${item.canonicalUrl})`,
    "",
    item.summary,
    "",
    `Source: ${item.canonicalUrl}`,
    "",
  ]);
  return [...frontmatter, `# ${title}`, "", ...body].join("\n");
}
