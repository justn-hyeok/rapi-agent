export const DEFAULT_ITEMS_PER_SOURCE = 3;

/**
 * Keeps the given (already ranked) order but stops one prolific source from
 * filling the whole batch. A source may raise its own cap with
 * `collection_policy.maxPerBatch`.
 */
export function capItemsPerSource<
  T extends { source_id: string; max_per_batch?: string | number | null },
>(rows: readonly T[], maxItems: number): T[] {
  const taken = new Map<string, number>();
  const selected: T[] = [];
  for (const row of rows) {
    if (selected.length >= maxItems) break;
    const configured = Number(row.max_per_batch);
    const cap =
      Number.isSafeInteger(configured) && configured > 0
        ? configured
        : DEFAULT_ITEMS_PER_SOURCE;
    const count = taken.get(row.source_id) ?? 0;
    if (count >= cap) continue;
    taken.set(row.source_id, count + 1);
    selected.push(row);
  }
  return selected;
}
