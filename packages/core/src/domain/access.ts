export interface DiscordIdentity {
  userId: string;
  guildId?: string;
  channelId?: string;
}

export interface DiscordAllowlists {
  userIds: readonly string[];
  guildIds?: readonly string[];
  channelIds?: readonly string[];
}

export function assertDiscordAccess(
  identity: DiscordIdentity,
  allowlists: DiscordAllowlists,
): void {
  if (!allowlists.userIds.includes(identity.userId))
    throw new Error("Discord user is not allowed");
  if (identity.guildId !== undefined) {
    if (!allowlists.guildIds?.includes(identity.guildId))
      throw new Error("Discord guild is not allowed");
    if (
      identity.channelId === undefined ||
      !allowlists.channelIds?.includes(identity.channelId)
    ) {
      throw new Error("Discord channel is not allowed");
    }
  }
}
