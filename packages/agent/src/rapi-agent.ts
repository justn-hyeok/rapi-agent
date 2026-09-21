import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { resolveProviderSelection } from "@rapi/contracts";
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
  deliveryPeriodWindow,
  renderBriefing,
  renderMdx,
  summarize,
} from "@rapi/core";
import {
  FeedSourceAdapter,
  GitHubSourceAdapter,
  parseFeed,
  parseGitHubEvent,
  type ExternalItem,
  MdxPublisher,
  UncertainDeliveryError,
} from "@rapi/adapters";
import { PostgresStore } from "@rapi/db";

export class RapiAgent {
  constructor(
    readonly store: PostgresStore,
    private readonly delivery: DeliveryAdapter,
    private readonly omp: OmpAdapter,
  ) {}

  createSource(
    kind: "github" | "rss" | "webhook" | "aside",
    locator: string,
    visibility: Visibility,
  ): Promise<string> {
    return this.store.createSource(kind, locator, visibility);
  }

  async ingestExternalItem(
    sourceId: string,
    item: ExternalItem,
    collectedAt = new Date(),
  ): Promise<{ itemId: string; inserted: boolean }> {
    const payload = { ...item };
    const raw = await this.store.insertRawEvent(
      sourceId,
      item.externalId || null,
      checksumPayload(payload),
      payload,
      collectedAt,
    );
    const visibility = await this.store.sourceVisibility(sourceId);
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
    const saved = await this.store.saveItem(normalized, summarize(normalized));
    return { itemId: saved.id, inserted: raw.inserted && saved.inserted };
  }

  async ingestFeed(
    sourceId: string,
    xml: string,
    collectedAt = new Date(),
  ): Promise<number> {
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
      sourceKind: "github" | "rss" | "webhook" | "aside";
      itemId: string;
      item: ExternalItem;
    }) => Promise<void>,
  ): Promise<void> {
    const sources = await this.store.collectableSources();
    await this.collectIndependently(
      sources.map((source) => ({
        sourceId: source.id,
        collect: async () => {
          if (source.kind === "rss") {
            const result = await feed.fetch(
              source.locator,
              source.etag ?? undefined,
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
          if (source.kind !== "github") return;
          const [owner, repository] = source.locator.split("/");
          if (!owner || !repository)
            throw new Error("GitHub source locator must be owner/repository");
          const result = await github.fetchRepositoryEvents(
            owner,
            repository,
            source.etag ?? undefined,
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

  async runScheduledDeliveries(now = new Date()): Promise<string[]> {
    const results: string[] = [];
    for (const subscription of await this.store.activeSubscriptions()) {
      const period = deliveryPeriodWindow(
        now,
        subscription.cadence === "weekly" ? "weekly" : "daily",
        subscription.timezone,
      );
      const batch = await this.freezeBatch(
        subscription.id,
        period.start,
        period.end,
      );
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
    const batch = await this.store.getBatch(batchId);
    if (batch.items.length === 0)
      return (await this.store.markEmptyBatchDelivered(batch.id))
        ? "delivered"
        : batch.state;
    const payload = renderBriefing("Rapi daily briefing", batch.items);
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
            : attempt.attempts >= 3
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
    const content = renderMdx(
      slug,
      "Rapi daily briefing",
      visibility,
      batch.items,
      generatedAt,
    );
    const filePath = await publisher.publish(slug, content);
    await this.store.recordPublication(
      batchId,
      visibility,
      filePath,
      createHash("sha256").update(content).digest("hex"),
    );
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
