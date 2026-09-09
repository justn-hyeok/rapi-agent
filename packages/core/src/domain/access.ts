export interface DiscordIdentity {
  userId: string;
  guildId?: string;
  channelId?: string;
  roleIds?: readonly string[];
  guildPermissions?: string;
}

export type DiscordAccessLevel = "user" | "admin" | "superadmin";

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
  return level;
}
