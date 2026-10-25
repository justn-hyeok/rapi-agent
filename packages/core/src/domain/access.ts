export interface DiscordIdentity {
  userId: string;
  guildId?: string;
  channelId?: string;
  roleIds?: readonly string[];
  guildPermissions?: string;
}

export type DiscordAccessLevel = "user" | "admin" | "superadmin";

/** "guild": the grant only covers the guild the request came from. */
export type DiscordAccessScope = "global" | "guild";

export interface DiscordAccess {
  level: DiscordAccessLevel;
  scope: DiscordAccessScope;
}

export interface DiscordAllowlists {
  /** Legacy owner allowlist. Every listed user is a superadmin. */
  userIds: readonly string[];
  superadminUserIds?: readonly string[];
  adminUserIds?: readonly string[];
  userUserIds?: readonly string[];
  adminRoleIds?: readonly string[];
  userRoleIds?: readonly string[];
  guildMembersAreUsers?: boolean;
  guildIds?: readonly string[];
  /** Operator guild. Unset means every allowed guild counts as home. */
  homeGuildId?: string;
  channelIds?: readonly string[];
}

const rank: Record<DiscordAccessLevel, number> = {
  user: 1,
  admin: 2,
  superadmin: 3,
};

export function assertDiscordLevel(
  actual: DiscordAccessLevel,
  required: DiscordAccessLevel,
): void {
  if (rank[actual] < rank[required])
    throw new Error(`${required.toUpperCase()} 권한이 필요합니다.`);
}

export function assertDiscordAccess(
  identity: DiscordIdentity,
  allowlists: DiscordAllowlists,
  required: DiscordAccessLevel = "user",
): DiscordAccessLevel {
  return resolveDiscordAccess(identity, allowlists, required).level;
}

/**
 * Resolves the level and how far it reaches. Outside the home guild, ADMIN
 * from the Discord Administrator permission or a role only reaches that
 * guild; SUPERADMIN and explicit admin user IDs stay global.
 */
export function resolveDiscordAccess(
  identity: DiscordIdentity,
  allowlists: DiscordAllowlists,
  required: DiscordAccessLevel = "user",
): DiscordAccess {
  if (identity.guildId !== undefined) {
    if (allowlists.guildIds && !allowlists.guildIds.includes(identity.guildId))
      throw new Error("Discord guild is not allowed");
    if (
      allowlists.channelIds &&
      (identity.channelId === undefined ||
        !allowlists.channelIds.includes(identity.channelId))
    ) {
      throw new Error("Discord channel is not allowed");
    }
  }
  const roles = identity.roleIds ?? [];
  let discordAdministrator: boolean;
  try {
    discordAdministrator =
      identity.guildPermissions !== undefined &&
      (BigInt(identity.guildPermissions) & (1n << 3n)) !== 0n;
  } catch {
    throw new Error("Discord permissions are invalid");
  }
  const level: DiscordAccessLevel | undefined =
    allowlists.userIds.includes(identity.userId) ||
    allowlists.superadminUserIds?.includes(identity.userId)
      ? "superadmin"
      : discordAdministrator ||
          allowlists.adminUserIds?.includes(identity.userId) ||
          allowlists.adminRoleIds?.some((role) => roles.includes(role))
        ? "admin"
        : allowlists.userUserIds?.includes(identity.userId) ||
            allowlists.userRoleIds?.some((role) => roles.includes(role))
          ? "user"
          : allowlists.guildMembersAreUsers &&
              identity.guildId !== undefined &&
              identity.roleIds !== undefined
            ? "user"
            : undefined;
  if (!level) throw new Error("Discord user is not allowed");
  assertDiscordLevel(level, required);
  const outsideHome =
    identity.guildId !== undefined &&
    allowlists.homeGuildId !== undefined &&
    identity.guildId !== allowlists.homeGuildId;
  const explicitAdmin =
    level === "superadmin" ||
    allowlists.adminUserIds?.includes(identity.userId) === true;
  return {
    level,
    scope: outsideHome && !explicitAdmin ? "guild" : "global",
  };
}

/** Throws unless the access reaches beyond a single guild. */
export function assertDiscordScope(
  access: DiscordAccess,
  effect: DiscordAccessScope,
  /** Commands the caller can use in this guild, shown in the refusal. */
  usable: readonly string[] = [],
): void {
  if (effect === "global" && access.scope === "guild")
    throw new Error(
      `이 명령은 운영자 서버나 DM에서만 사용할 수 있습니다.${
        usable.length
          ? ` 이 서버에서는 ${usable.join(", ")}을(를) 쓸 수 있어요.`
          : ""
      }`,
    );
}
