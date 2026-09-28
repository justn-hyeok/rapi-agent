export function executePrivacyCommand(
  identity: { guildId?: string; userId: string },
  options: Record<string, unknown>,
  level: string,
  key: string,
  connectionString: string,
): Promise<{ messages: string[] }>;
