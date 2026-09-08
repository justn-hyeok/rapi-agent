export type Visibility = "private" | "unlisted" | "public";

export interface SourceRecord {
  id: string;
  kind: "github" | "rss" | "webhook" | "aside";
  locator: string;
  visibility: Visibility;
}

export interface RawInput {
  externalId: string | null;
  payload: unknown;
  collectedAt: Date;
}

export interface NormalizedItem {
  id: string;
  rawEventId: string;
  sourceId: string;
  normalizerVersion: string;
  canonicalUrl: string;
  title: string;
  body: string;
  author: string | null;
  publishedAt: Date | null;
  collectedAt: Date;
  visibility: Visibility;
  contentFingerprint: string;
  metadata: Record<string, unknown>;
  categories: string[];
}

export interface DeliveryTarget {
  channel: "discord_dm" | "discord_channel" | "email";
  recipientId: string;
}

export interface SubscriptionInput {
  ownerId: string;
  name: string;
  sourceIds: string[];
  categories: string[];
  includeKeywords: string[];
  excludeKeywords: string[];
  cadence: "immediate" | "daily" | "weekly";
  timezone: string;
  channels: DeliveryTarget[];
  maxItems: number;
}

export interface BriefingItem {
  id: string;
  title: string;
  canonicalUrl: string;
  summary: string;
  categories: string[];
  visibility: Visibility;
}

export interface FrozenBatch {
  id: string;
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  rendererVersion: string;
  state: string;
  targets: DeliveryTarget[];
  items: BriefingItem[];
}

export interface DeliveryPayload {
  subject: string;
  text: string;
  html: string;
  itemIds: string[];
}

export interface DeliveryResult {
  providerId: string;
}

export interface DeliveryAdapter {
  send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
    idempotencyKey: string,
  ): Promise<DeliveryResult>;
}

export interface OmpDispatchResult {
  receiptId: string;
  accepted: boolean;
  reason?: string;
}

export interface OmpAdapter {
  dispatch(
    specification: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<OmpDispatchResult>;
}
