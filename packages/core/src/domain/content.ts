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

function decodeEntities(value: string): string {
  return value.replace(
    /&(nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,
    (_, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x"))
        return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#"))
        return String.fromCodePoint(Number(lower.slice(1)));
      return (
        {
          nbsp: " ",
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
        }[lower] ?? ""
      );
    },
  );
}

// Only real HTML tags: a title such as "Agents <ship>" or "Vec<String>" stays as written.
const HTML_TAG =
  /<\/?(?:a|abbr|article|aside|audio|b|blockquote|body|br|button|center|code|dd|del|details|div|dl|dt|em|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|label|li|main|mark|nav|ol|p|path|picture|pre|s|section|small|source|span|strong|sub|summary|sup|svg|table|tbody|td|th|thead|time|tr|u|ul|video)\b[^>]*>/gi;

/**
 * Feed text as people read it: entity-escaped HTML is decoded first, then tags,
 * comments, scripts and styles go. Anything shown in Discord or mail goes through this.
 */
export function plainText(value: string, limit = 2000): string {
  let text = value;
  for (let pass = 0; pass < 2 && /&(lt|gt|amp);/i.test(text); pass += 1)
    text = decodeEntities(text);
  return decodeEntities(
    text
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(HTML_TAG, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function summarize(
  item: Pick<NormalizedItem, "title" | "body">,
): string {
  const clean = plainText(item.body, 4000);
  if (clean.length === 0) return plainText(item.title, 300);
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

/** One briefing entry per item, except that a repository group becomes one entry. */
export function briefingEntries(
  items: BriefingItem[],
): Array<BriefingItem & { count: number }> {
  const groupCounts = new Map<string, number>();
  for (const item of items)
    if (item.groupKey)
      groupCounts.set(item.groupKey, (groupCounts.get(item.groupKey) ?? 0) + 1);
  const rendered = new Set<string>();
  const entries: Array<BriefingItem & { count: number }> = [];
  for (const item of items) {
    if (!item.groupKey) {
      entries.push({ ...item, count: 1 });
      continue;
    }
    if (rendered.has(item.groupKey)) continue;
    rendered.add(item.groupKey);
    const count = groupCounts.get(item.groupKey) ?? 1;
    entries.push(
      count > 1
        ? {
            ...item,
            count,
            title: `${item.groupKey} · GitHub 활동 ${count}건`,
            canonicalUrl: `https://github.com/${item.groupKey}`,
          }
        : { ...item, count },
    );
  }
  return entries;
}

function clip(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function renderBriefing(
  title: string,
  items: BriefingItem[],
  options: { link?: string; dateLabel?: string; upcoming?: string[] } = {},
): DeliveryPayload {
  const entries = briefingEntries(items).map((item) => ({
    ...item,
    title: plainText(item.title, 300) || item.title,
    summary: plainText(item.summary, 600) || item.summary,
  }));
  const textLines = [
    title,
    ...(options.link ? [`전체 보기: ${options.link}`] : []),
    "",
  ];
  const htmlItems: string[] = [];
  for (const item of entries) {
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
  const link = options.link
    ? `<p><a href="${escapeHtml(options.link)}">전체 보기</a></p>`
    : "";
  return {
    subject: title,
    text: textLines.join("\n").trimEnd(),
    html: `<!doctype html><html><body><h1>${escapeHtml(title)}</h1>${link}<ul>${htmlItems.join("")}</ul></body></html>`,
    itemIds: items.map((item) => item.id),
    ...(options.link
      ? {
          discord: {
            embeds: [
              {
                title: `오늘 볼 것 ${entries.length}건`,
                url: options.link,
                description: entries
                  .slice(0, 3)
                  .map(
                    (item, index) =>
                      `**${"①②③"[index]} [${clip(item.title, 90).replace(/[[\]]/g, "")}](${item.canonicalUrl})**\n${clip(item.summary, 150)}`,
                  )
                  .join("\n\n"),
                ...(options.upcoming?.length
                  ? {
                      fields: [
                        {
                          name: "다가오는 일정",
                          value: options.upcoming
                            .map((line) => clip(line, 100))
                            .join("\n"),
                        },
                      ],
                    }
                  : {}),
                ...(options.dateLabel
                  ? { footer: { text: options.dateLabel } }
                  : {}),
                color: 0x365d46,
              },
            ],
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 5, label: "전체 보기", url: options.link },
                ],
              },
            ],
          },
        }
      : {}),
  };
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Discord does not draw Markdown tables, so a table becomes one bullet per row:
 * the first column in bold, the others as "heading: value". Code blocks stay as written.
 */
export function discordMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) fenced = !fenced;
    const next = lines[index + 1];
    if (
      !fenced &&
      line.includes("|") &&
      next !== undefined &&
      next.includes("-") &&
      TABLE_SEPARATOR.test(next)
    ) {
      const heads = tableCells(line);
      let row = index + 2;
      while (row < lines.length && lines[row]!.includes("|")) {
        const cells = tableCells(lines[row]!);
        const rest = cells
          .slice(1)
          .map((cell, column) =>
            cell
              ? `${heads[column + 1] ?? ""}: ${cell}`.replace(/^: /, "")
              : "",
          )
          .filter(Boolean);
        out.push(
          `- **${cells[0] ?? ""}**${rest.length ? ` — ${rest.join(" · ")}` : ""}`,
        );
        row += 1;
      }
      index = row - 1;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
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
    `## [${escapeMdx(item.title)}](${mdxUrl(item.canonicalUrl)})`,
    "",
    escapeMdx(item.summary),
    "",
    `Source: [${escapeMdx(item.canonicalUrl)}](${mdxUrl(item.canonicalUrl)})`,
    "",
  ]);
  return [...frontmatter, `# ${escapeMdx(title)}`, "", ...body].join("\n");
}

export function escapeMdx(value: string): string {
  // Treat source text as text, including JSX, expressions and Markdown syntax.
  return value.replace(
    /[&<>[\]{}\\`*_#!|]/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

export function mdxUrl(value: string): string {
  return canonicalizeUrl(value).replace(
    /[()<>"'{}\\]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
