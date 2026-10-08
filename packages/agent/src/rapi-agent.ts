import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { resolveProviderSelection } from "@rapi/contracts";
export { DEFAULT_CODEX_MODEL as DEFAULT_SUMMARY_MODEL } from "@rapi/contracts";
import type {
  DeliveryAdapter,
  DeliveryTarget,
  FrozenBatch,
  OmpAdapter,
  SubscriptionInput,
  Visibility,
} from "@rapi/core";
import {
  canonicalizeUrl,
  checksumPayload,
  classify,
  contentFingerprint,
  completedDeliveryPeriodWindow,
  renderBriefing,
  renderMdx,
  repositoryKey,
  BRIEFING_SECTIONS,
  learnPreferences,
  preferenceScore,
  formatScheduleWhen,
  parseScheduleText,
  scheduleDaysUntil,
  renderBriefingPage,
  signBriefingToken,
  verifyBriefingToken,
  type BriefingPageEntry,
  type BriefingPageDraft,
  type BriefingSection,
  summarize,
} from "@rapi/core";
import {
  FeedSourceAdapter,
  GitHubSourceAdapter,
  GitHubStarRecommender,
  fetchCollectedEvents,
  SUMMARY_PROMPT_VERSION,
  DETAIL_PROMPT_VERSION,
  readSource,
  plainText,
  repositoryContext,
  type ItemSummarizer,
  type RepositoryDescriber,
  type SummaryInput,
  parseFeed,
  parseGitHubEvent,
  type ExternalItem,
  MdxPublisher,
  UncertainDeliveryError,
  PermanentDeliveryError,
  type SourcePayload,
} from "@rapi/adapters";
import { PostgresStore } from "@rapi/db";
import type { PoolClient } from "pg";

// A feed URL that embeds a credential (e.g. GitHub's private dashboard feed)
// is stored as `env:NAME` so the secret stays in the service environment and
// out of the database, status commands and raw payloads.
export function resolveFeedLocator(
  locator: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!locator.startsWith("env:")) return locator;
  const name = locator.slice(4);
  if (!/^[A-Z][A-Z0-9_]*_FEED_URL$/.test(name))
    throw new Error("Feed locator environment name must end with _FEED_URL");
  const value = environment[name];
  if (!value?.startsWith("https://"))
    throw new Error(`${name} must be an https URL`);
  return value;
}

export function redactUrlTokens(body: string): string {
  return body.replace(
    /([?&](?:token|access_token)=)[^&"'<>\s]+/g,
    "$1REDACTED",
  );
}

export class RapiAgent {
  constructor(
    readonly store: PostgresStore,
    private readonly delivery: DeliveryAdapter,
    private readonly omp: OmpAdapter,
    private readonly summarizer?: ItemSummarizer,
    private readonly repositories?: RepositoryDescriber,
    private readonly briefingLinks?: { key: Buffer; baseUrl: string },
  ) {}

  private curation?: {
    feeds: {
      drafts(): Promise<unknown[]>;
      sendDraft(key: string): Promise<{ ok: boolean; message: string }>;
      discardDraft(key: string): Promise<{ ok: boolean; message: string }>;
    };
    curators: string[];
  };

  /** Lets these Discord users review curation drafts on their briefing page. */
  enableCuration(
    feeds: NonNullable<RapiAgent["curation"]>["feeds"],
    curators: string[],
  ): void {
    this.curation = { feeds, curators };
  }

  async briefingCuration(
    batchId: string,
    token: string,
    input: { action?: unknown; key?: unknown },
  ): Promise<{ status: number; body: unknown }> {
    if (!this.briefingTokenValid(batchId, token))
      return {
        status: 403,
        body: { ok: false, message: "링크가 만료됐습니다." },
      };
    const ownerId = await this.store.batchOwner(batchId);
    if (!this.curation || !ownerId || !this.curation.curators.includes(ownerId))
      return {
        status: 403,
        body: { ok: false, message: "큐레이션 권한이 없습니다." },
      };
    if (typeof input.key !== "string")
      return {
        status: 400,
        body: { ok: false, message: "초안을 찾지 못했습니다." },
      };
    const result =
      input.action === "send"
        ? await this.curation.feeds.sendDraft(input.key)
        : input.action === "discard"
          ? await this.curation.feeds.discardDraft(input.key)
          : { ok: false, message: "알 수 없는 동작입니다." };
    return {
      status: result.ok ? 200 : 400,
      body: { ...result, drafts: await this.curation.feeds.drafts() },
    };
  }

  briefingLink(batchId: string, now = new Date()): string | undefined {
    if (!this.briefingLinks) return undefined;
    const url = new URL(`/b/${batchId}`, this.briefingLinks.baseUrl);
    url.searchParams.set(
      "t",
      signBriefingToken(this.briefingLinks.key, batchId, now),
    );
    return url.href;
  }

  private briefingTokenValid(batchId: string, token: string): boolean {
    return (
      !!this.briefingLinks &&
      /^[0-9a-f-]{36}$/.test(batchId) &&
      verifyBriefingToken(this.briefingLinks.key, batchId, token)
    );
  }

  /** The owner's briefing page, or undefined for an invalid or expired link. */
  async briefingPage(
    batchId: string,
    token: string,
  ): Promise<{ html: string; nonce: string } | undefined> {
    if (!this.briefingTokenValid(batchId, token)) return undefined;
    const batch = await this.store.briefingRows(batchId);
    if (!batch) return undefined;
    const entries: BriefingPageEntry[] = [];
    const groups = new Map<string, BriefingPageEntry & { count: number }>();
    const preferences = learnPreferences(
      await this.store.feedbackSignals(batch.ownerId),
    );
    const sections = new Set<string>(BRIEFING_SECTIONS.map((s) => s.id));
    for (const row of batch.rows) {
      const group =
        row.group_by === "repository" ? repositoryKey(row.url) : null;
      const existing = group ? groups.get(group) : undefined;
      if (existing) {
        existing.count += 1;
        existing.meta = `활동 ${existing.count}건`;
        existing.url = `https://github.com/${group}`;
        continue;
      }
      const stars = row.source_kind === "github_stars";
      let summary = row.summary;
      let why: string | undefined;
      if (stars) {
        const parts = row.summary.split(" · ");
        const at = parts.findIndex((part) => part.startsWith("★"));
        if (at > 0) {
          why = parts.slice(0, at).join(" · ");
          summary = parts.slice(at + 1).join(" · ") || parts[at]!;
        }
      }
      const section = (
        row.source_section && sections.has(row.source_section)
          ? row.source_section
          : stars || group || row.source_kind === "github"
            ? "github"
            : row.source_kind === "aside"
              ? "tools"
              : "industry"
      ) as BriefingSection;
      let host: string;
      try {
        host = new URL(row.source_locator).hostname.replace(/^www\./, "");
      } catch {
        host = "GitHub";
      }
      const entry = {
        id: row.id,
        title: stars
          ? typeof row.metadata.repository === "string"
            ? row.metadata.repository
            : row.title
          : (group ?? row.title),
        url: row.url,
        summary,
        ...(why
          ? { why }
          : ((reason) => (reason ? { why: reason } : {}))(
              preferenceScore(
                { sourceId: row.source_id, title: row.title },
                preferences,
              ).reason,
            )),
        source:
          row.source_label ??
          (stars ? "GitHub 추천" : group ? "팔로우 활동" : host),
        section,
        meta: stars
          ? `★${Number(row.metadata.stars ?? 0).toLocaleString("en-US")}`
          : row.published_at
            ? new Intl.DateTimeFormat("ko-KR", {
                timeZone: "Asia/Seoul",
                month: "long",
                day: "numeric",
              }).format(row.published_at)
            : "",
        repository: stars || !!group,
        feedback: {
          up: row.feedback.includes("up"),
          down: row.feedback.includes("down"),
          save: row.feedback.includes("save"),
        },
        count: 1,
      };
      if (group) groups.set(group, entry);
      entries.push(entry);
    }
    const dateLabel = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(batch.periodEnd);
    return renderBriefingPage({
      batchId,
      token,
      dateLabel,
      entries,
      events: await this.upcomingEvents(batch.ownerId),
      ...(this.curation?.curators.includes(batch.ownerId)
        ? {
            curation:
              (await this.curation.feeds.drafts()) as BriefingPageDraft[],
          }
        : {}),
    });
  }

  /** Collected deadlines refresh at most every 6 hours. */
  async collectEvents(
    now = new Date(),
  ): Promise<{ saved: number; failures: string[] }> {
    const last = await this.store.lastCollectedEventAt();
    if (last && now.getTime() - last.getTime() < 6 * 3_600_000)
      return { saved: 0, failures: [] };
    const { events, failures } = await fetchCollectedEvents(now);
    for (const event of events) await this.store.upsertCollectedEvent(event);
    return { saved: events.length, failures };
  }

  async upcomingEvents(ownerId: string, days = 30, now = new Date()) {
    const rows = await this.store.listEvents(
      ownerId,
      new Date(now.getTime() - 12 * 3_600_000),
      new Date(now.getTime() + days * 86_400_000),
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      kind: row.kind,
      source: row.source,
      when: formatScheduleWhen(row.starts_at, row.all_day),
      daysUntil: scheduleDaysUntil(row.starts_at, now),
    }));
  }

  /** Schedule commands shared by the briefing page and Discord. */
  async scheduleCommand(
    ownerId: string,
    input: { action?: unknown; text?: unknown; id?: unknown },
    now = new Date(),
  ): Promise<
    | { ok: true; message: string; preview?: { title: string; when: string } }
    | { ok: false; message: string }
  > {
    if (input.action === "preview" || input.action === "add") {
      if (typeof input.text !== "string" || !input.text.trim())
        return { ok: false, message: "일정 내용을 적어 주세요." };
      const parsed = parseScheduleText(input.text, now);
      if ("error" in parsed) return { ok: false, message: parsed.error };
      const when = formatScheduleWhen(parsed.startsAt, parsed.allDay);
      if (input.action === "preview")
        return {
          ok: true,
          message: `${when} · ${parsed.title}`,
          preview: { title: parsed.title, when },
        };
      await this.store.addEvent(ownerId, parsed);
      return {
        ok: true,
        message: `일정을 추가했습니다: ${when} · ${parsed.title}`,
      };
    }
    if (input.action === "delete") {
      if (typeof input.id !== "string" || !/^[0-9a-f-]{36}$/.test(input.id))
        return { ok: false, message: "삭제할 일정을 찾지 못했습니다." };
      return (await this.store.removeEvent(ownerId, input.id))
        ? { ok: true, message: "일정을 지웠습니다." }
        : { ok: false, message: "삭제할 일정을 찾지 못했습니다." };
    }
    return { ok: false, message: "알 수 없는 일정 명령입니다." };
  }

  async briefingSchedule(
    batchId: string,
    token: string,
    input: unknown,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.briefingTokenValid(batchId, token))
      return {
        status: 403,
        body: { ok: false, message: "링크가 만료됐습니다." },
      };
    const batch = await this.store.briefingRows(batchId);
    if (!batch)
      return {
        status: 404,
        body: { ok: false, message: "브리핑을 찾지 못했습니다." },
      };
    const result = await this.scheduleCommand(
      batch.ownerId,
      (input ?? {}) as Record<string, unknown>,
    );
    return {
      status: result.ok ? 200 : 400,
      body: { ...result, events: await this.upcomingEvents(batch.ownerId) },
    };
  }

  /** Key points of one briefing item, read from the original page once and cached. */
  async briefingDetail(
    batchId: string,
    token: string,
    itemId: unknown,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.briefingTokenValid(batchId, token))
      return {
        status: 403,
        body: { ok: false, message: "링크가 만료됐습니다." },
      };
    if (typeof itemId !== "string" || !/^[0-9a-f-]{36}$/.test(itemId))
      return {
        status: 400,
        body: { ok: false, message: "항목을 찾지 못했습니다." },
      };
    const item = await this.store.itemInBatch(batchId, itemId);
    if (!item)
      return {
        status: 404,
        body: { ok: false, message: "항목을 찾지 못했습니다." },
      };
    const summarizer = this.summarizer;
    if (!summarizer?.detail)
      return {
        status: 503,
        body: { ok: false, message: "정리 기능이 꺼져 있습니다." },
      };
    const cached = await this.store.itemDetail(itemId, summarizer.policy);
    if (cached)
      return {
        status: 200,
        body: { ok: true, points: JSON.parse(cached) as string[] },
      };
    let text = item.body;
    try {
      const { body } = await readSource(
        item.url,
        {
          "User-Agent": "rapi-agent",
          Accept: "text/html,application/xhtml+xml",
        },
        { timeoutMs: 15_000, maxBodyBytes: 2_000_000 },
      );
      if (body.length > text.length) text = body;
    } catch {
      // Paywalled or blocked pages fall back to the collected text.
    }
    const points = await summarizer.detail({
      title: item.title,
      url: item.url,
      text,
    });
    if (!points.length)
      return {
        status: 502,
        body: {
          ok: false,
          message: "정리하지 못했습니다. 원문을 열어 주세요.",
        },
      };
    await this.store.saveItemDetail(
      itemId,
      summarizer.policy,
      DETAIL_PROMPT_VERSION,
      JSON.stringify(points),
    );
    await this.store.setItemFeedback(batchId, itemId, "open", true);
    return { status: 200, body: { ok: true, points } };
  }

  async recordBriefingFeedback(
    batchId: string,
    token: string,
    input: unknown,
  ): Promise<"ok" | "forbidden" | "invalid"> {
    if (!this.briefingTokenValid(batchId, token)) return "forbidden";
    const { itemId, kind, on } = (input ?? {}) as Record<string, unknown>;
    if (
      typeof itemId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(itemId) ||
      !["up", "down", "save", "open"].includes(kind as string) ||
      typeof on !== "boolean"
    )
      return "invalid";
    return (await this.store.setItemFeedback(
      batchId,
      itemId,
      kind as "up" | "down" | "save" | "open",
      on,
    ))
      ? "ok"
      : "invalid";
  }

  // Model summaries are written once per item and reused by every retry, so
  // a delivered briefing never changes between attempts.
  async summarizeBatch(batchId: string): Promise<number> {
    if (!this.summarizer) return 0;
    const items = await this.store.itemsNeedingSummary(
      batchId,
      this.summarizer.policy,
    );
    if (items.length === 0) return 0;
    // Activity in one repository is delivered as one entry, so it is
    // summarized as one unit and the result is stored for every member.
    const units = new Map<
      string,
      { key: string | null; members: typeof items }
    >();
    for (const item of items) {
      const key =
        item.group_by === "repository" ? repositoryKey(item.url) : null;
      const unit = units.get(key ? `g:${key}` : `i:${item.id}`) ?? {
        key,
        members: [],
      };
      unit.members.push(item);
      units.set(key ? `g:${key}` : `i:${item.id}`, unit);
    }
    const inputs: SummaryInput[] = [];
    for (const { key, members } of units.values()) {
      const lead = members[0]!;
      const repository = key ?? repositoryKey(lead.url);
      const info = repository
        ? await this.repositories?.describe(repository)
        : undefined;
      inputs.push({
        id: lead.id,
        url: lead.url,
        title:
          members.length > 1 ? `${key} 활동 ${members.length}건` : lead.title,
        body:
          members.length > 1
            ? members
                .map(
                  (member) =>
                    `- ${member.title}: ${plainText(member.body, 500)}`,
                )
                .join("\n")
            : lead.body,
        ...(info ? { context: repositoryContext(info) } : {}),
      });
    }
    const summaries = await this.summarizer.summarize(inputs);
    let saved = 0;
    for (const { members } of units.values()) {
      const content = summaries.get(members[0]!.id);
      if (!content) continue;
      for (const member of members) {
        await this.store.saveItemSummary(
          member.id,
          this.summarizer.policy,
          SUMMARY_PROMPT_VERSION,
          content,
        );
        saved += 1;
      }
    }
    return saved;
  }

  createSource(
    kind: "github" | "rss" | "webhook" | "aside" | "github_stars",
    locator: string,
    visibility: Visibility,
  ): Promise<string> {
    return this.store.createSource(kind, locator, visibility);
  }

  async ingestExternalItem(
    sourceId: string,
    item: ExternalItem,
    collectedAt = new Date(),
    transactionClient?: PoolClient,
  ): Promise<{ itemId: string; inserted: boolean }> {
    const payload = { ...item };
    const raw = await this.store.insertRawEvent(
      sourceId,
      item.externalId || null,
      checksumPayload(payload),
      payload,
      collectedAt,
      transactionClient,
    );
    if (raw.retired) return { itemId: raw.id, inserted: false };
    const visibility = await this.store.sourceVisibility(
      sourceId,
      transactionClient,
    );
    const normalized = {
      id: randomUUID(),
      rawEventId: raw.id,
      sourceId,
      normalizerVersion: "source-v1",
      canonicalUrl: canonicalizeUrl(item.url),
      title: item.title.trim(),
      body: item.body.trim(),
      author: item.author,
      publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
      collectedAt,
      visibility,
      contentFingerprint: contentFingerprint(item.title, item.body),
      metadata: item.metadata,
      categories: classify(item.title, item.body),
    };
    const saved = await this.store.saveItem(
      normalized,
      summarize(normalized),
      transactionClient,
    );
    return { itemId: saved.id, inserted: raw.inserted && saved.inserted };
  }

  async ingestFeed(
    sourceId: string,
    xml: string,
    collectedAt = new Date(),
  ): Promise<number> {
    await this.persistSourcePayload(
      sourceId,
      { contentType: "application/xml", body: xml },
      collectedAt,
    );
    let inserted = 0;
    for (const item of parseFeed(xml)) {
      const result = await this.ingestExternalItem(sourceId, item, collectedAt);
      if (result.inserted) inserted += 1;
    }
    await this.store.saveCursor(sourceId, collectedAt.toISOString(), null);
    return inserted;
  }

  async ingestGitHub(
    sourceId: string,
    payloads: Record<string, unknown>[],
    collectedAt = new Date(),
  ): Promise<number> {
    await this.persistSourcePayload(
      sourceId,
      { contentType: "application/json", body: JSON.stringify(payloads) },
      collectedAt,
    );
    let inserted = 0;
    for (const payload of payloads) {
      const result = await this.ingestExternalItem(
        sourceId,
        parseGitHubEvent(payload),
        collectedAt,
      );
      if (result.inserted) inserted += 1;
    }
    await this.store.saveCursor(sourceId, collectedAt.toISOString(), null);
    return inserted;
  }

  async collectIndependently(
    jobs: Array<{ sourceId: string; collect: () => Promise<void> }>,
  ): Promise<void> {
    await Promise.all(
      jobs.map(async (job) => {
        try {
          await job.collect();
        } catch (error) {
          await this.store.recordSourceFailure(
            job.sourceId,
            error instanceof Error ? error.message : "Unknown collection error",
          );
        }
      }),
    );
  }

  async collectConfiguredSources(
    feed: FeedSourceAdapter,
    github: GitHubSourceAdapter,
    onInserted?: (input: {
      sourceId: string;
      sourceKind: "github" | "rss" | "webhook" | "aside" | "github_stars";
      itemId: string;
      item: ExternalItem;
    }) => Promise<void>,
    stars?: GitHubStarRecommender,
  ): Promise<void> {
    const sources = await this.store.collectableSources();
    await this.collectIndependently(
      sources.map((source) => ({
        sourceId: source.id,
        collect: async () => {
          if (source.kind === "rss") {
            const secret = source.locator.startsWith("env:");
            const result = await feed.fetch(
              resolveFeedLocator(source.locator),
              source.etag ?? undefined,
              (payload) =>
                this.persistSourcePayload(
                  source.id,
                  secret
                    ? { ...payload, body: redactUrlTokens(payload.body) }
                    : payload,
                ),
            );
            for (const item of result.items) {
              const saved = await this.ingestExternalItem(source.id, item);
              if (saved.inserted)
                await onInserted?.({
                  sourceId: source.id,
                  sourceKind: source.kind,
                  itemId: saved.itemId,
                  item,
                });
            }
            await this.store.saveCursor(
              source.id,
              new Date().toISOString(),
              result.etag ?? null,
            );
            return;
          }
          if (source.kind === "github_stars") {
            if (!stars)
              throw new Error("GitHub star recommendations are not configured");
            // Recommendations are a daily digest, not a polled stream.
            if (
              source.last_success_at &&
              Date.now() - new Date(source.last_success_at).getTime() <
                20 * 3_600_000
            )
              return;
            const exclude = new Set(
              await this.store.sourceExternalIds(source.id),
            );
            for (const item of await stars.recommend(source.locator, exclude))
              await this.ingestExternalItem(source.id, item);
            await this.store.saveCursor(
              source.id,
              new Date().toISOString(),
              null,
            );
            return;
          }
          if (source.kind !== "github") return;
          const [owner, repository] = source.locator.split("/");
          if (!owner || !repository)
            throw new Error("GitHub source locator must be owner/repository");
          const result = await github.fetchRepositoryEvents(
            owner,
            repository,
            source.etag ?? undefined,
            (payload) => this.persistSourcePayload(source.id, payload),
          );
          for (const item of result.items) {
            const saved = await this.ingestExternalItem(source.id, item);
            if (saved.inserted)
              await onInserted?.({
                sourceId: source.id,
                sourceKind: "github",
                itemId: saved.itemId,
                item,
              });
          }
          await this.store.saveCursor(
            source.id,
            new Date().toISOString(),
            result.etag ?? null,
          );
        },
      })),
    );
  }

  private async persistSourcePayload(
    sourceId: string,
    payload: SourcePayload,
    collectedAt = new Date(),
  ): Promise<void> {
    await this.store.insertRawEvent(
      sourceId,
      null,
      checksumPayload(payload),
      payload,
      collectedAt,
    );
  }

  async runScheduledDeliveries(now = new Date()): Promise<string[]> {
    const results: string[] = [];
    for (const subscription of await this.store.activeSubscriptions()) {
      const attempted = new Set<string>();
      for (const id of await this.store.pendingDeliveryBatchIds(
        subscription.id,
      )) {
        results.push(await this.deliverBatch(id));
        attempted.add(id);
      }
      let period: { start: Date; end: Date };
      if (subscription.cadence === "immediate") {
        const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
        const previous = await this.store.latestDeliveryPeriodEnd(
          subscription.id,
        );
        if (previous && previous >= end) continue;
        period = { start: previous ?? new Date(end.getTime() - 60_000), end };
      } else {
        // Freeze completed periods, so a midnight tick cannot permanently
        // exclude items collected later in that same day or week.
        period = completedDeliveryPeriodWindow(
          now,
          subscription.cadence === "weekly" ? "weekly" : "daily",
          subscription.timezone,
        );
      }
      const batch = await this.freezeBatch(
        subscription.id,
        period.start,
        period.end,
      );
      if (!attempted.has(batch.id))
        results.push(await this.deliverBatch(batch.id));
    }
    return results;
  }

  createSubscription(input: SubscriptionInput): Promise<string> {
    return this.store.createSubscription(input);
  }

  freezeBatch(
    subscriptionId: string,
    start: Date,
    end: Date,
  ): Promise<FrozenBatch> {
    return this.store.freezeBatch(subscriptionId, start, end);
  }

  async deliverBatch(batchId: string): Promise<string> {
    try {
      await this.summarizeBatch(batchId);
    } catch (error) {
      // A model failure must not block delivery; items fall back to labeled excerpts.
      process.stderr.write(
        `Summaries skipped: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    }
    const batch = await this.store.getBatch(batchId);
    if (batch.items.length === 0)
      return (await this.store.markEmptyBatchDelivered(batch.id))
        ? "delivered"
        : batch.state;
    const link = this.briefingLink(batch.id);
    const ownerId = await this.store.batchOwner(batch.id);
    const upcoming = ownerId
      ? (await this.upcomingEvents(ownerId, 7))
          .filter((event) => event.daysUntil >= 0)
          .slice(0, 3)
      : [];
    const payload = renderBriefing("Rapi daily briefing", batch.items, {
      ...(link ? { link } : {}),
      upcoming: upcoming.map(
        (event) =>
          `${event.daysUntil === 0 ? "오늘" : `D-${event.daysUntil}`} · ${event.when} · ${event.title}`,
      ),
      dateLabel: new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "long",
        day: "numeric",
        weekday: "short",
      }).format(batch.periodEnd),
    });
    for (const target of batch.targets) {
      const attempt = await this.store.beginDelivery(
        batch.id,
        target,
        batch.rendererVersion,
      );
      if (attempt.skip) continue;
      const key = `${batch.id}:${target.channel}:${target.recipientId}:${batch.rendererVersion}`;
      try {
        const result = await this.delivery.send(target, payload, key);
        await this.store.finishDelivery(
          attempt.id,
          "success",
          result.providerId,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown delivery failure";
        await this.store.finishDelivery(
          attempt.id,
          error instanceof UncertainDeliveryError
            ? "uncertain"
            : error instanceof PermanentDeliveryError || attempt.attempts >= 3
              ? "permanent_failure"
              : "temporary_failure",
          undefined,
          message,
        );
      }
    }
    return this.store.reconcileBatch(batch.id);
  }

  async publishBatch(
    batchId: string,
    visibility: Visibility,
    slug: string,
    publisher: MdxPublisher,
    generatedAt = new Date(),
  ): Promise<string> {
    const batch = await this.store.getBatch(batchId);
    if (!batch.items.length)
      throw new Error("Cannot publish an empty or expired batch");
    const content = renderMdx(
      slug,
      "Rapi daily briefing",
      visibility,
      batch.items,
      generatedAt,
    );
    const filePath = await publisher.publish(slug, content);
    const hash = createHash("sha256").update(content).digest("hex");
    try {
      await this.store.recordPublication(batchId, visibility, filePath, hash);
    } catch (error) {
      await publisher.removeIfUnchanged(filePath, hash);
      throw error;
    }
    return filePath;
  }

  createTask(
    requesterId: string,
    specification: Record<string, unknown>,
  ): Promise<{ taskId: string; revision: number }> {
    const permissions = Array.isArray(specification.permissions)
      ? specification.permissions
      : [];
    const risk = permissions.some((permission) =>
      ["push", "deploy", "repo:write", "commit:create"].includes(
        String(permission),
      ),
    )
      ? "high"
      : "low";
    return this.store.createTask(
      requesterId,
      {
        ...specification,
        ...resolveProviderSelection(specification),
      },
      risk,
    );
  }

  approveTask(
    taskId: string,
    revision: number,
    approverId: string,
    permissions: string[],
    messageRef: string,
    expiresAt = new Date(Date.now() + 15 * 60_000),
  ): Promise<string> {
    return this.store.approveTask(
      taskId,
      revision,
      approverId,
      permissions,
      expiresAt,
      messageRef,
    );
  }

  async dispatchTask(taskId: string): Promise<{
    attemptId: string;
    receiptId: string;
    provider: string;
    model?: string | undefined;
  }> {
    const prepared = await this.store.prepareDispatch(taskId, "omp");
    const selection = resolveProviderSelection(prepared.specification);
    if (prepared.existingReceipt)
      return {
        attemptId: prepared.attemptId,
        receiptId: prepared.existingReceipt,
        ...selection,
      };
    const result = await this.omp.dispatch(
      prepared.specification,
      prepared.idempotencyKey,
    );
    await this.store.recordDispatch(
      prepared.attemptId,
      result.receiptId,
      result.accepted,
      result.reason,
    );
    return {
      attemptId: prepared.attemptId,
      receiptId: result.receiptId,
      ...selection,
    };
  }

  async cancelTask(taskId: string): Promise<void> {
    const attempt = await this.store.latestTaskExecution(taskId);
    if (
      attempt &&
      ["dispatched", "running", "blocked"].includes(attempt.state)
    ) {
      if (!attempt.receiptId || !this.omp.cancel)
        throw new Error(
          "실행기 접수 또는 취소 기능을 확인할 수 없습니다. 취소 상태는 미확정입니다.",
        );
      if (!(await this.omp.cancel(attempt.receiptId, attempt.id)))
        throw new Error(
          "프로세스가 이미 종료됐거나 중단을 확인하지 못했습니다.",
        );
      if ((await this.store.taskState(taskId)) !== "cancelled")
        throw new Error(
          "실행기 중단은 확인했지만 DB 상태 반영은 미확정입니다.",
        );
      return;
    }
    if ((await this.store.taskState(taskId)) !== "cancelled")
      await this.store.cancelTask(taskId);
  }

  async receiveOmpCallback(
    rawBody: Buffer,
    signature: string,
    secret: string,
  ): Promise<boolean> {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    if (left.length !== right.length || !timingSafeEqual(left, right))
      throw new Error("Invalid OMP callback signature");
    const callback = JSON.parse(rawBody.toString("utf8")) as {
      callback_event_id: string;
      receipt_id: string;
      execution_attempt_id: string;
      state_version: number;
      state: "running" | "blocked" | "completed" | "failed" | "cancelled";
      result_report_ref?: string;
      evidence_refs?: string[];
    };
    if (
      callback.state === "completed" &&
      (!callback.result_report_ref || !callback.evidence_refs?.length)
    ) {
      throw new Error("Completed callback is missing required evidence");
    }
    const applied = await this.store.applyCallback(
      callback.callback_event_id,
      callback.execution_attempt_id,
      callback.receipt_id,
      callback.state_version,
      callback.state,
      callback as unknown as Record<string, unknown>,
    );
    if (applied) {
      const ownerId = await this.store.executionOwner(
        callback.execution_attempt_id,
      );
      await this.delivery.send(
        { channel: "discord_dm", recipientId: ownerId },
        {
          subject: `OMP task ${callback.state}`,
          text: `OMP 실행 상태: ${callback.state}`,
          html: `<p>OMP 실행 상태: ${callback.state}</p>`,
          itemIds: [],
        },
        `callback:${callback.callback_event_id}`,
      );
    }
    return applied;
  }
}

export class CompositeDeliveryAdapter implements DeliveryAdapter {
  constructor(
    private readonly adapters: Record<
      DeliveryTarget["channel"],
      DeliveryAdapter
    >,
  ) {}

  send(
    target: DeliveryTarget,
    payload: Parameters<DeliveryAdapter["send"]>[1],
    key: string,
  ) {
    return this.adapters[target.channel].send(target, payload, key);
  }
}
