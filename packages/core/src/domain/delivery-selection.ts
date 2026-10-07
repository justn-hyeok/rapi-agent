export const DEFAULT_ITEMS_PER_SOURCE = 3;
export const MAX_ITEMS_PER_GROUP = 5;

const NON_REPOSITORY_OWNERS = new Set([
  "about",
  "apps",
  "collections",
  "enterprise",
  "explore",
  "features",
  "marketplace",
  "notifications",
  "orgs",
  "settings",
  "sponsors",
  "topics",
  "trending",
]);

/** `owner/repo` for a github.com URL, or null for any other URL. */
export function repositoryKey(url: string): string | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:[/?#]|$)/.exec(
    url,
  );
  if (!match || NON_REPOSITORY_OWNERS.has(match[1]!.toLowerCase())) return null;
  return `${match[1]}/${match[2]!.replace(/\.git$/, "")}`;
}

/**
 * Keeps the given (already ranked) order but stops one prolific source from
 * filling the whole batch. A source may raise its own cap with
 * `collection_policy.maxPerBatch`. Rows sharing a `group_key` within a source
 * are delivered as one entry, so they count once toward both limits.
 */
export function capItemsPerSource<
  T extends {
    source_id: string;
    max_per_batch?: string | number | null;
    group_key?: string | null;
  },
>(rows: readonly T[], maxItems: number): T[] {
  const entriesPerSource = new Map<string, number>();
  const groupSizes = new Map<string, number>();
  const selected: T[] = [];
  let entries = 0;
  for (const row of rows) {
    const group = row.group_key
      ? `${row.source_id}\u0000${row.group_key}`
      : null;
    const size = group ? groupSizes.get(group) : undefined;
    if (size !== undefined) {
      if (size >= MAX_ITEMS_PER_GROUP) continue;
      groupSizes.set(group!, size + 1);
      selected.push(row);
      continue;
    }
    if (entries >= maxItems) continue;
    const configured = Number(row.max_per_batch);
    const cap =
      Number.isSafeInteger(configured) && configured > 0
        ? configured
        : DEFAULT_ITEMS_PER_SOURCE;
    const count = entriesPerSource.get(row.source_id) ?? 0;
    if (count >= cap) continue;
    entriesPerSource.set(row.source_id, count + 1);
    if (group) groupSizes.set(group, 1);
    entries += 1;
    selected.push(row);
  }
  return selected;
}
