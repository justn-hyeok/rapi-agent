import type { Client } from "pg";
export function expireSourceContent(
  client: Client,
  options?: {
    apply?: boolean;
    publishedHistory?: string;
    withdrawalsFile?: string;
    now?: Date;
  },
): Promise<{
  mode: string;
  checkedAt: string;
  expiredItems: number;
  pendingItemsDeferred: number;
  publishedItems: number;
  applied: boolean;
  rawBodiesExpired?: number;
  summariesRemoved?: number | null;
  classificationsRemoved?: number | null;
  publicationsWithdrawn?: number | null;
}>;
