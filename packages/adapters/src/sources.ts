import { XMLParser } from "fast-xml-parser";

export interface ExternalItem {
  externalId: string;
  url: string;
  title: string;
  body: string;
  author: string | null;
  publishedAt: string | null;
  metadata: Record<string, unknown>;
}

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (value && typeof value === "object" && "#text" in value)
    return text((value as { "#text": unknown })["#text"]);
  return "";
}

function atomLink(value: unknown): string {
  for (const link of arrayOf(value)) {
    if (typeof link === "string") return link;
    if (link && typeof link === "object") {
      const record = link as Record<string, unknown>;
      if (
        (record["@_rel"] === undefined || record["@_rel"] === "alternate") &&
        typeof record["@_href"] === "string"
      )
        return record["@_href"];
    }
  }
  return "";
}

export function parseFeed(xml: string): ExternalItem[] {
  if (Buffer.byteLength(xml) > 2_000_000)
    throw new Error("Feed exceeds the 2 MB input limit");
  if (/<!DOCTYPE/i.test(xml))
    throw new Error("DOCTYPE is not allowed in feeds");
  const parser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;

  const rss = parsed.rss as { channel?: { item?: unknown } } | undefined;
  if (rss?.channel) {
    return arrayOf(
      rss.channel.item as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    ).map((item) => {
      const url = text(item.link);
      const externalId = text(item.guid) || url;
      return {
        externalId,
        url,
        title: text(item.title),
        body: text(item.description) || text(item["content:encoded"]),
        author: text(item.author) || text(item["dc:creator"]) || null,
        publishedAt: text(item.pubDate) || null,
        metadata: { feedType: "rss" },
      };
    });
  }

  const feed = parsed.feed as { entry?: unknown } | undefined;
  if (feed) {
    return arrayOf(
      feed.entry as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    ).map((entry) => {
      const url = atomLink(entry.link);
      const author = entry.author as Record<string, unknown> | undefined;
      return {
        externalId: text(entry.id) || url,
        url,
        title: text(entry.title),
        body: text(entry.summary) || text(entry.content),
        author: author ? text(author.name) || null : null,
        publishedAt: text(entry.published) || text(entry.updated) || null,
        metadata: { feedType: "atom" },
      };
    });
  }

  throw new Error("Unsupported RSS/Atom document");
}

export function parseGitHubEvent(
  payload: Record<string, unknown>,
): ExternalItem {
  const repository = (payload.repository ?? payload.repo) as
    | Record<string, unknown>
    | undefined;
  const eventPayload = payload.payload as Record<string, unknown> | undefined;
  const issue = eventPayload?.issue as Record<string, unknown> | undefined;
  const pullRequest = eventPayload?.pull_request as
    | Record<string, unknown>
    | undefined;
  const commits = arrayOf(
    eventPayload?.commits as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | undefined,
  );
  const commit = commits[0];
  const repositoryName = text(repository?.full_name) || text(repository?.name);
  const externalId =
    text(payload.id) || text(payload.node_id) || text(payload.after);
  const url =
    text(payload.html_url) ||
    text(payload.url) ||
    text(issue?.html_url) ||
    text(pullRequest?.html_url) ||
    text(commit?.url) ||
    (repositoryName ? `https://github.com/${repositoryName}` : "");
  if (!externalId || !url)
    throw new Error("GitHub event requires an id and URL");
  return {
    externalId,
    url,
    title:
      text(payload.title) ||
      text(issue?.title) ||
      text(pullRequest?.title) ||
      text(payload.message) ||
      text(commit?.message) ||
      `GitHub change ${externalId}`,
    body:
      text(payload.body) ||
      text(issue?.body) ||
      text(pullRequest?.body) ||
      text(payload.description) ||
      text(payload.message) ||
      text(commit?.message),
    author:
      text((payload.user as Record<string, unknown> | undefined)?.login) ||
      text((payload.author as Record<string, unknown> | undefined)?.login) ||
      text((payload.actor as Record<string, unknown> | undefined)?.login) ||
      null,
    publishedAt:
      text(payload.updated_at) ||
      text(payload.created_at) ||
      text(payload.timestamp) ||
      null,
    metadata: {
      repository: repositoryName,
      eventType: text(payload.type) || "change",
    },
  };
}

export class GitHubSourceAdapter {
  constructor(private readonly token?: string) {}

  async fetchRepositoryEvents(
    owner: string,
    repository: string,
    etag?: string,
  ): Promise<{ items: ExternalItem[]; etag?: string }> {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repository}/events`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "rapi-agent",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      },
    );
    if (response.status === 304)
      return { items: [], ...(etag ? { etag } : {}) };
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const payload = (await response.json()) as Record<string, unknown>[];
    const responseEtag = response.headers.get("etag") ?? undefined;
    return {
      items: payload.map(parseGitHubEvent),
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  }
}

export class FeedSourceAdapter {
  async fetch(
    url: string,
    etag?: string,
  ): Promise<{ items: ExternalItem[]; etag?: string }> {
    const response = await fetch(url, {
      headers: etag ? { "If-None-Match": etag } : {},
    });
    if (response.status === 304)
      return { items: [], ...(etag ? { etag } : {}) };
    if (!response.ok) throw new Error(`Feed returned ${response.status}`);
    const responseEtag = response.headers.get("etag") ?? undefined;
    return {
      items: parseFeed(await response.text()),
      ...(responseEtag ? { etag: responseEtag } : {}),
    };
  }
}

export interface AsideResearchJob {
  sourceId: string;
  locator: string;
  purpose: string;
  schedule: string;
  visibility: "private" | "unlisted";
}
