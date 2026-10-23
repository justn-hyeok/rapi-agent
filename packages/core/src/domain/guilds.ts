export type GuildStatus = "pending" | "allowed" | "rejected" | "left";

export type GuildAdmission = "none" | "request" | "leave";

/** Home guild: explicit setting, then the community guild, then the first allowed guild. */
export function resolveHomeGuildId(
  home: string | undefined,
  community: string | undefined,
  allowed: readonly string[] | undefined,
): string | undefined {
  return home ?? community ?? allowed?.[0];
}

/**
 * Guilds the bot answers in: the env list, approved guilds and the home guild.
 * Undefined means nothing is configured, which keeps the old open behavior.
 */
export function allowedGuildIds(
  envIds: readonly string[] | undefined,
  approvedIds: readonly string[],
  homeGuildId?: string,
): string[] | undefined {
  const ids = new Set([
    ...(envIds ?? []),
    ...approvedIds,
    ...(homeGuildId ? [homeGuildId] : []),
  ]);
  return ids.size ? [...ids] : undefined;
}

export function isGuildAllowed(
  guildId: string,
  allowed: readonly string[] | undefined,
): boolean {
  return allowed === undefined || allowed.includes(guildId);
}

/** What to do when the gateway reports a guild the bot is in. */
export function decideGuildAdmission(
  guildId: string,
  envIds: readonly string[] | undefined,
  status: GuildStatus | undefined,
): GuildAdmission {
  if (envIds?.includes(guildId)) return "none";
  if (status === "allowed" || status === "pending") return "none";
  if (status === "rejected") return "leave";
  return "request";
}

/** Whether a ChatOps message from this guild may run code or change state. */
export function chatOpsExecutionAllowed(
  guildId: string,
  homeGuildId: string | undefined,
): boolean {
  return homeGuildId === undefined || guildId === homeGuildId;
}

export interface FeedGuildTarget {
  guildId: string;
  /** When the guild was approved; null for env/home guilds that always receive. */
  allowedSince: Date | null;
}

/**
 * Guilds that should receive a post: not yet sent there, and not approved
 * after the post was created (no backlog for new guilds).
 */
export function selectFeedTargets(
  postCreatedAt: Date,
  guilds: readonly FeedGuildTarget[],
  alreadySent: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const guild of guilds) {
    if (alreadySent.has(guild.guildId) || seen.has(guild.guildId)) continue;
    if (guild.allowedSince && guild.allowedSince > postCreatedAt) continue;
    seen.add(guild.guildId);
    result.push(guild.guildId);
  }
  return result;
}

/** Caches the approved-guild lookup so every interaction does not hit the database. */
export function createGuildGate(options: {
  envIds: readonly string[] | undefined;
  homeGuildId: string | undefined;
  load: () => Promise<readonly string[]>;
  ttlMs?: number;
  now?: () => number;
}): {
  allowed(): Promise<string[] | undefined>;
  invalidate(): void;
} {
  const ttl = options.ttlMs ?? 15_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; ids: string[] | undefined } | undefined;
  return {
    async allowed() {
      if (cached && now() - cached.at < ttl) return cached.ids;
      const ids = allowedGuildIds(
        options.envIds,
        await options.load(),
        options.homeGuildId,
      );
      cached = { at: now(), ids };
      return ids;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
