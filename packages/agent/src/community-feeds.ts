import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readSource, type ItemSummarizer } from "@rapi/adapters";
import {
  findCitations,
  isFreeTokenNews,
  kstDateKey,
  kstReached,
  kstWeekday,
  selectProjectRepositories,
  type CitationCandidate,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";

type Feed = "projects" | "setup" | "stars" | "ai-blogs" | "free-tokens";
type Embed = Record<string, unknown>;

export const CURATION_CHANNELS: Record<Feed, string> = {
  projects: "curation_projects",
  setup: "curation_setup",
  stars: "curation_setup",
  "ai-blogs": "curation_ai_blogs",
  "free-tokens": "curation_free_tokens",
};

const clip = (value: string, limit: number) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

export const CURATION_FEED_LABELS: Record<Feed, string> = {
  projects: "프로젝트 소식",
  setup: "세팅 소개",
  stars: "추천 레포",
  "ai-blogs": "AI 블로그",
  "free-tokens": "무료 토큰",
};

export interface CommunityFeedOptions {
  guildId: string;
  owner: string;
  /** Feeds posted without review; the rest become drafts for the owner to send. */
  autoPost?: Partial<Record<Feed, boolean>>;
  /** Only these repositories are introduced, when set. */
  projects?: string[];
  setupFile?: string;
  githubToken?: string;
  /** Posts one Discord message and returns its id. */
  post(channelId: string, embeds: Embed[]): Promise<string>;
  getJson?: (url: string, accept?: string) => Promise<unknown>;
  getText?: (url: string, accept?: string) => Promise<string>;
}

interface Repo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  private: boolean;
  pushed_at: string;
  stargazers_count: number;
  language: string | null;
}

/** The four curation channels: projects, setup and stars, AI blogs, free tokens. */
export class CommunityFeeds {
  private readonly getText: (url: string, accept?: string) => Promise<string>;
  private readonly getJson: (url: string, accept?: string) => Promise<unknown>;

  constructor(
    private readonly store: PostgresStore,
    private readonly summarizer: ItemSummarizer | undefined,
    private readonly options: CommunityFeedOptions,
  ) {
    this.getText =
      options.getText ??
      (async (url, accept = "application/vnd.github+json") =>
        (
          await readSource(
            url,
            {
              "User-Agent": "rapi-agent",
              Accept: accept,
              ...(options.githubToken &&
              url.startsWith("https://api.github.com/")
                ? { Authorization: `Bearer ${options.githubToken}` }
                : {}),
            },
            { timeoutMs: 20_000, maxBodyBytes: 4_000_000 },
          )
        ).body);
    this.getJson =
      options.getJson ??
      (async (url, accept) =>
        JSON.parse(await this.getText(url, accept)) as unknown);
  }

  private async channel(feed: Feed): Promise<string | null> {
    return this.store.managedDiscordResourceId(
      this.options.guildId,
      "channel",
      CURATION_CHANNELS[feed],
    );
  }

  /**
   * Posts once per key, or saves a draft for feeds that need the owner's
   * review. Returns false when the key exists or the channel is missing.
   */
  private async publish(
    feed: Feed,
    key: string,
    embeds: Embed[],
    data: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!embeds.length || (await this.store.communityPostExists(key)))
      return false;
    if (!this.options.autoPost?.[feed]) {
      await this.store.saveCommunityDraft({
        key,
        feed,
        title: typeof embeds[0]!.title === "string" ? embeds[0]!.title : key,
        embeds: embeds.slice(0, 10),
      });
      return true;
    }
    const channelId = await this.channel(feed);
    if (!channelId) return false;
    const messageId = await this.options.post(channelId, embeds.slice(0, 10));
    await this.store.recordCommunityPost({
      key,
      feed,
      channelId,
      messageId,
      data,
    });
    return true;
  }

  async drafts(): Promise<
    Array<{
      key: string;
      feed: string;
      label: string;
      title: string;
      preview: string;
    }>
  > {
    return (await this.store.communityDrafts()).map((draft) => {
      const embed = (draft.embeds[0] ?? {}) as Embed;
      return {
        key: draft.key,
        feed: draft.feed,
        label:
          (CURATION_FEED_LABELS as Record<string, string | undefined>)[
            draft.feed
          ] ?? draft.feed,
        title: draft.title,
        preview: clip(
          typeof embed.description === "string" ? embed.description : "",
          500,
        ),
      };
    });
  }

  /** Sends a reviewed draft to its channel, once. */
  async sendDraft(key: string): Promise<{ ok: boolean; message: string }> {
    const draft = await this.store.communityDraft(key);
    if (!draft) return { ok: false, message: "이미 보냈거나 없는 초안입니다." };
    const channelId = await this.channel(draft.feed as Feed);
    if (!channelId)
      return { ok: false, message: "채널이 아직 만들어지지 않았습니다." };
    const messageId = await this.options.post(
      channelId,
      draft.embeds as Embed[],
    );
    await this.store.settleCommunityDraft(key, "posted", channelId, messageId);
    return { ok: true, message: "채널에 보냈습니다." };
  }

  async discardDraft(key: string): Promise<{ ok: boolean; message: string }> {
    return (await this.store.settleCommunityDraft(key, "discarded"))
      ? { ok: true, message: "초안을 버렸습니다." }
      : { ok: false, message: "이미 처리된 초안입니다." };
  }

  /** Runs every feed that is due; one failing feed never blocks the others. */
  async runOnce(now = new Date()): Promise<string[]> {
    const failures: string[] = [];
    const run = async (name: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(
          `${name}: ${error instanceof Error ? error.message : "failed"}`,
        );
      }
    };
    await run("setup", () => this.setup());
    if (await this.due("projects", 3 * 3_600_000, now))
      await run("projects", () => this.projects(now));
    if (kstWeekday(now) === 1 && kstReached(now, 10))
      await run("stars", () => this.stars(now));
    if (kstReached(now, 9)) await run("ai-blogs", () => this.aiBlogs(now));
    if (await this.due("free-tokens", 6 * 3_600_000, now, "free-models:"))
      await run("free-models", () => this.freeModels());
    if (kstReached(now, 9, 5)) await run("free-news", () => this.freeNews(now));
    return failures;
  }

  /** A periodic feed is due when its last check marker is older than the interval. */
  private async due(
    feed: Feed,
    interval: number,
    now: Date,
    prefix = `${feed}:check:`,
  ): Promise<boolean> {
    const last = await this.store.lastCommunityPostAt(feed, prefix);
    if (last && now.getTime() - last.getTime() < interval) return false;
    await this.store.recordCommunityPost({
      key: `${prefix}${now.toISOString()}`,
      feed,
      channelId: null,
      messageId: null,
      data: {},
    });
    return true;
  }

  async setup(): Promise<boolean> {
    if (!this.options.setupFile) return false;
    const text = (await readFile(this.options.setupFile, "utf8")).trim();
    const [heading, ...rest] = text.split("\n");
    const version = createHash("sha256")
      .update(text)
      .digest("hex")
      .slice(0, 12);
    return this.publish("setup", `setup:${version}`, [
      {
        title: clip(heading!.replace(/^#\s*/, ""), 250),
        description: rest.join("\n").trim().slice(0, 4000),
        color: 0x365d46,
      },
    ]);
  }

  async projectIntroductions(
    now: Date,
  ): Promise<Array<{ repo: Repo; points: string[] }>> {
    const repos = (await this.getJson(
      `https://api.github.com/users/${this.options.owner}/repos?per_page=100&sort=pushed`,
    )) as Repo[];
    const selected = selectProjectRepositories(
      repos.map((repo) => ({ ...repo, pushedAt: repo.pushed_at })),
      this.options.owner,
      now,
    ).filter(
      (repo) =>
        !this.options.projects || this.options.projects.includes(repo.name),
    );
    const introductions: Array<{ repo: Repo; points: string[] }> = [];
    for (const repo of selected) {
      if (await this.store.communityPostExists(`project:${repo.full_name}`))
        continue;
      let readme = "";
      try {
        readme = await this.getText(
          `https://api.github.com/repos/${repo.full_name}/readme`,
          "application/vnd.github.raw",
        );
      } catch {
        // A repository without a README is introduced from its description.
      }
      // Nothing to introduce from: no description and no meaningful README.
      if (!repo.description && readme.trim().length < 200) continue;
      const points = this.summarizer?.detail
        ? await this.summarizer.detail({
            title: repo.name,
            url: repo.html_url,
            text: `${repo.description ?? ""}\n\n${readme}`,
          })
        : [];
      introductions.push({
        repo,
        points: points.length
          ? points
          : [repo.description ?? "설명이 아직 없습니다."],
      });
    }
    return introductions;
  }

  async projects(now: Date): Promise<void> {
    for (const { repo, points } of await this.projectIntroductions(now))
      await this.publish("projects", `project:${repo.full_name}`, [
        {
          title: `새 프로젝트 · ${repo.name}`,
          url: repo.html_url,
          description: [
            repo.description ? `**${clip(repo.description, 300)}**` : "",
            ...points.map((p) => `- ${p}`),
          ]
            .filter(Boolean)
            .join("\n"),
          footer: {
            text: [repo.language, `★${repo.stargazers_count}`]
              .filter(Boolean)
              .join(" · "),
          },
          color: 0x365d46,
        },
      ]);
    const repos = (await this.getJson(
      `https://api.github.com/users/${this.options.owner}/repos?per_page=100&sort=pushed`,
    )) as Repo[];
    for (const repo of selectProjectRepositories(
      repos.map((r) => ({ ...r, pushedAt: r.pushed_at })),
      this.options.owner,
      now,
    ).filter(
      (r) => !this.options.projects || this.options.projects.includes(r.name),
    )) {
      if (now.getTime() - Date.parse(repo.pushed_at) > 14 * 86_400_000)
        continue;
      const releases = (await this.getJson(
        `https://api.github.com/repos/${repo.full_name}/releases?per_page=3`,
      )) as Array<{
        tag_name: string;
        name: string | null;
        html_url: string;
        body: string | null;
        published_at: string | null;
        draft: boolean;
      }>;
      for (const release of releases) {
        if (
          release.draft ||
          !release.published_at ||
          now.getTime() - Date.parse(release.published_at) > 14 * 86_400_000
        )
          continue;
        const key = `release:${repo.full_name}:${release.tag_name}`;
        if (await this.store.communityPostExists(key)) continue;
        const summary = this.summarizer
          ? (
              await this.summarizer.summarize([
                {
                  id: key,
                  title: `${repo.name} ${release.tag_name}`,
                  url: release.html_url,
                  body: release.body ?? "",
                },
              ])
            ).get(key)
          : undefined;
        await this.publish("projects", key, [
          {
            title: `${repo.name} ${release.name || release.tag_name} 릴리스`,
            url: release.html_url,
            description: clip(summary ?? release.body ?? "", 1500),
            color: 0x365d46,
          },
        ]);
      }
    }
  }

  async stars(now: Date): Promise<void> {
    const key = `stars:${kstDateKey(now)}`;
    if (await this.store.communityPostExists(key)) return;
    const since =
      (await this.store.lastCommunityPostAt("stars", "stars:2")) ??
      new Date(now.getTime() - 7 * 86_400_000);
    const starred = (await this.getJson(
      `https://api.github.com/users/${this.options.owner}/starred?per_page=50`,
      "application/vnd.github.star+json",
    )) as Array<{ starred_at: string; repo: Repo & { topics?: string[] } }>;
    const fresh = starred
      .filter(
        (s) => Date.parse(s.starred_at) > since.getTime() && !s.repo.private,
      )
      .slice(0, 12);
    if (!fresh.length) return;
    const lines = this.summarizer
      ? await this.summarizer.summarize(
          fresh.map((s) => ({
            id: s.repo.full_name,
            title: s.repo.full_name,
            url: s.repo.html_url,
            body: `${s.repo.description ?? ""} topics: ${(s.repo.topics ?? []).join(", ")}`,
          })),
        )
      : new Map<string, string>();
    await this.publish("stars", key, [
      {
        title: `이번 주 star한 저장소 ${fresh.length}개`,
        description: fresh
          .map(
            (s) =>
              `**[${s.repo.full_name}](${s.repo.html_url})** ★${s.repo.stargazers_count}\n${clip(lines.get(s.repo.full_name) ?? s.repo.description ?? "", 160)}`,
          )
          .join("\n\n")
          .slice(0, 4000),
        color: 0x365d46,
      },
    ]);
  }

  async aiBlogs(now: Date): Promise<void> {
    const key = `ai-blogs:${kstDateKey(now)}`;
    if (await this.store.communityPostExists(key)) return;
    const official = await this.store.officialItems(
      new Date(now.getTime() - 26 * 3_600_000),
    );
    if (!official.length) return;
    const others: CitationCandidate[] = await this.store.citationCandidates(
      new Date(now.getTime() - 7 * 86_400_000),
    );
    const embeds = official.slice(0, 10).map((item) => {
      const citations = findCitations(item, others).slice(0, 5);
      return {
        title: clip(`${item.source} · ${item.title}`, 250),
        url: item.url,
        description: clip(item.summary, 600),
        ...(citations.length
          ? {
              fields: [
                {
                  name: `이 글을 다룬 곳 ${citations.length}`,
                  value: clip(
                    citations
                      .map(
                        (c) =>
                          `[${clip(`${c.source}: ${c.title}`, 70)}](${c.url})`,
                      )
                      .join("\n"),
                    1000,
                  ),
                },
              ],
            }
          : {}),
        color: 0x365d46,
      };
    });
    await this.publish("ai-blogs", key, embeds);
  }

  async freeModels(): Promise<void> {
    const models =
      (
        (await this.getJson("https://openrouter.ai/api/v1/models")) as {
          data?: Array<{
            id: string;
            name?: string;
            context_length?: number;
            pricing?: { prompt?: string; completion?: string };
          }>;
        }
      ).data ?? [];
    const free = models.filter(
      (m) => m.pricing?.prompt === "0" && m.pricing.completion === "0",
    );
    const known = new Set(await this.store.communityPostKeys("free-model:"));
    const first = known.size === 0;
    const fresh = free.filter((m) => !known.has(`free-model:${m.id}`));
    for (const model of fresh)
      await this.store.recordCommunityPost({
        key: `free-model:${model.id}`,
        feed: "free-tokens",
        channelId: null,
        messageId: null,
        data: { name: model.name ?? model.id },
      });
    if (!fresh.length) return;
    const list = fresh
      .slice(0, 25)
      .map(
        (m) =>
          `- **${m.name ?? m.id}** \`${m.id}\`${m.context_length ? ` · 컨텍스트 ${Math.round(m.context_length / 1000)}K` : ""}`,
      );
    await this.publish(
      "free-tokens",
      `free-models-post:${createHash("sha256")
        .update(fresh.map((m) => m.id).join(","))
        .digest("hex")
        .slice(0, 16)}`,
      [
        {
          title: first
            ? `OpenRouter에서 지금 무료인 모델 ${free.length}개`
            : `OpenRouter 새 무료 모델 ${fresh.length}개`,
          url: "https://openrouter.ai/models?max_price=0",
          description: clip(list.join("\n"), 3900),
          footer: {
            text: "무료 모델은 사용량 제한이 있고 예고 없이 바뀔 수 있습니다.",
          },
          color: 0x365d46,
        },
      ],
    );
  }

  async freeNews(now: Date): Promise<void> {
    const key = `free-news:${kstDateKey(now)}`;
    if (await this.store.communityPostExists(key)) return;
    const items = (
      await this.store.citationCandidates(
        new Date(now.getTime() - 26 * 3_600_000),
      )
    ).filter((item) => isFreeTokenNews(item.title, item.body));
    if (!items.length) return;
    await this.publish("free-tokens", key, [
      {
        title: `무료 크레딧·무료 티어 소식 ${items.length}건`,
        description: clip(
          items
            .slice(0, 10)
            .map((i) => `- [${clip(i.title, 90)}](${i.url}) · ${i.source}`)
            .join("\n"),
          3900,
        ),
        color: 0x365d46,
      },
    ]);
  }
}

/** Builds the feeds from config/curation in a release root, posting as the bot. */
export async function createCommunityFeeds(input: {
  store: PostgresStore;
  summarizer: ItemSummarizer | undefined;
  guildId: string;
  botToken: string;
  root: string;
  githubToken?: string;
  owner?: string;
}): Promise<CommunityFeeds> {
  let config: {
    autoPost?: Partial<Record<Feed, boolean>>;
    projects?: string[];
  } = {};
  try {
    config = JSON.parse(
      await readFile(`${input.root}/config/curation/feeds.json`, "utf8"),
    ) as typeof config;
  } catch {
    // Without a config every feed waits for review.
  }
  return new CommunityFeeds(input.store, input.summarizer, {
    guildId: input.guildId,
    owner: input.owner ?? "justn-hyeok",
    setupFile: `${input.root}/config/curation/setup.md`,
    ...(config.autoPost ? { autoPost: config.autoPost } : {}),
    ...(config.projects ? { projects: config.projects } : {}),
    ...(input.githubToken ? { githubToken: input.githubToken } : {}),
    post: async (channelId, embeds) => {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bot ${input.botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ embeds, allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`Discord returned ${response.status}`);
      const message = (await response.json()) as { id?: unknown };
      return typeof message.id === "string" ? message.id : "";
    },
  });
}
