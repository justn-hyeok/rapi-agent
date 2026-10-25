import { escapeMdx, mdxUrl } from "./content.js";
import { LEARNER_SECTIONS, safeLearnerUrl } from "./learner.js";
import type { LearnerSection } from "./learner.js";

export type BlogPostKind = "issue" | "guide";
export type BlogPostStatus = "draft" | "approved" | "published" | "withdrawn";

/** Allowed status moves; everything else (including leaving `withdrawn`) is refused. */
const TRANSITIONS: Record<BlogPostStatus, BlogPostStatus[]> = {
  // draft → approved is the owner's [게시]; discarding deletes the draft row.
  draft: ["approved"],
  // approved → published once the PR is merged; back to draft when it is closed.
  approved: ["published", "draft"],
  published: ["withdrawn"],
  withdrawn: [],
};

export function canTransitionBlogPost(
  from: BlogPostStatus,
  to: BlogPostStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isBlogSlug = (value: string): boolean => SLUG.test(value);

/** Folds any text into a slug the blog build accepts. */
export function blogSlug(...parts: string[]): string {
  const slug = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  if (!slug) throw new Error("Blog slug is empty");
  return slug;
}

export interface BlogIssueItem {
  section: LearnerSection;
  title: string;
  summary: string;
  url: string;
}

export interface BlogIssueInput {
  cadence: "daily" | "weekly";
  periodKey: string;
  items: BlogIssueItem[];
}

const CADENCE_LABEL = { daily: "매일", weekly: "매주" } as const;
const SUMMARY_LIMIT = 400;
const TITLE_LIMIT = 120;

const clip = (value: string, limit: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

/** Frontmatter values are JSON strings so a title cannot add or break keys. */
function frontmatter(fields: {
  title: string;
  slug: string;
  description: string;
  date: Date;
}): string[] {
  return [
    "---",
    `title: ${JSON.stringify(fields.title)}`,
    `slug: ${JSON.stringify(fields.slug)}`,
    `description: ${JSON.stringify(fields.description)}`,
    "visibility: public",
    `date: ${fields.date.toISOString()}`,
    "---",
    "",
  ];
}

export function blogIssueSlug(cadence: string, periodKey: string): string {
  return blogSlug("learner", cadence, periodKey);
}

/**
 * Web edition of a learner issue: item summaries and original links only.
 * Never the original text; every string is escaped as plain text.
 */
export function renderIssuePost(
  issue: BlogIssueInput,
  date: Date,
): { slug: string; title: string; description: string; mdx: string } {
  const slug = blogIssueSlug(issue.cadence, issue.periodKey);
  const title = `라피 학습자 소식 · ${clip(issue.periodKey, 40)}`;
  const description = `${CADENCE_LABEL[issue.cadence]} 받는 학습자 소식의 웹 버전이에요. 항목마다 요약과 원문 링크를 담았어요.`;
  const body: string[] = [`# ${escapeMdx(title)}`, ""];
  let count = 0;
  for (const section of LEARNER_SECTIONS) {
    const items = issue.items.flatMap((item) => {
      const url = safeLearnerUrl(item.url);
      return item.section === section.id && url ? [{ item, url }] : [];
    });
    if (!items.length) continue;
    body.push(`## ${escapeMdx(section.label)}`, "");
    for (const { item, url } of items) {
      count += 1;
      body.push(
        `### [${escapeMdx(clip(item.title, TITLE_LIMIT))}](${mdxUrl(url)})`,
        "",
      );
      const summary = clip(item.summary, SUMMARY_LIMIT);
      if (summary) body.push(escapeMdx(summary), "");
      body.push(
        `원문: [${escapeMdx(new URL(url).hostname)}](${mdxUrl(url)})`,
        "",
      );
    }
  }
  if (!count) throw new Error("An issue post needs at least one linked item");
  return {
    slug,
    title,
    description,
    mdx: [...frontmatter({ title, slug, description, date }), ...body].join(
      "\n",
    ),
  };
}

export interface GuideContent {
  title: string;
  description: string;
  sections: Array<{ heading: string; body: string }>;
  sources: Array<{ title: string; url: string }>;
}

export const GUIDE_LIMITS = {
  title: 80,
  description: 200,
  sections: 8,
  heading: 80,
  body: 2000,
  sources: 5,
} as const;

/** Validates the model's JSON; anything malformed is an error, never a partial post. */
export function parseGuideContent(text: string): GuideContent {
  let data: unknown;
  try {
    data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("블로그 초안 응답이 JSON이 아닙니다.");
  }
  if (!data || typeof data !== "object")
    throw new Error("블로그 초안 응답 형식이 올바르지 않습니다.");
  const raw = data as Record<string, unknown>;
  const text1 = (value: unknown, limit: number, name: string): string => {
    if (typeof value !== "string" || !value.trim())
      throw new Error(`블로그 초안에 ${name}이(가) 없습니다.`);
    return value.trim().slice(0, limit);
  };
  if (!Array.isArray(raw.sections) || !raw.sections.length)
    throw new Error("블로그 초안에 본문이 없습니다.");
  const sections = raw.sections.slice(0, GUIDE_LIMITS.sections).map((entry) => {
    const section = (entry ?? {}) as Record<string, unknown>;
    return {
      heading: text1(section.heading, GUIDE_LIMITS.heading, "소제목"),
      body: text1(section.body, GUIDE_LIMITS.body, "본문"),
    };
  });
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .slice(0, GUIDE_LIMITS.sources)
    .flatMap((entry) => {
      const source = (entry ?? {}) as Record<string, unknown>;
      const url = safeLearnerUrl(source.url);
      return url && typeof source.title === "string" && source.title.trim()
        ? [{ title: source.title.trim().slice(0, TITLE_LIMIT), url }]
        : [];
    });
  return {
    title: text1(raw.title, GUIDE_LIMITS.title, "제목"),
    description: text1(raw.description, GUIDE_LIMITS.description, "설명"),
    sections,
    sources,
  };
}

/** Guide text is model output: render it as inert text, links only from `sources`. */
export function renderGuidePost(
  slug: string,
  content: GuideContent,
  date: Date,
): string {
  if (!isBlogSlug(slug)) throw new Error("Invalid blog slug");
  const body = [`# ${escapeMdx(content.title)}`, ""];
  for (const section of content.sections)
    body.push(
      `## ${escapeMdx(section.heading)}`,
      "",
      ...section.body
        .split(/\n{2,}/)
        .flatMap((paragraph) => [escapeMdx(paragraph.trim()), ""]),
    );
  if (content.sources.length) {
    body.push("## 참고한 곳", "");
    for (const source of content.sources)
      body.push(`- [${escapeMdx(source.title)}](${mdxUrl(source.url)})`);
    body.push("");
  }
  return [
    ...frontmatter({
      title: content.title,
      slug,
      description: content.description,
      date,
    }),
    ...body,
  ].join("\n");
}

/** Reads title and description back from stored frontmatter (JSON-quoted values). */
export function blogPostMeta(mdx: string): {
  title: string;
  description: string;
} {
  const field = (name: string): string => {
    const match = new RegExp(`^${name}: (".*")$`, "m").exec(mdx);
    try {
      return match ? String(JSON.parse(match[1]!)) : "";
    } catch {
      return "";
    }
  };
  return { title: field("title"), description: field("description") };
}
