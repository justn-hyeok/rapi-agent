export function replaceEnvironmentValue(
  contents: string,
  name: string,
  value: string,
): string;

export function validateDiscordBotToken(
  token: string,
  request?: typeof fetch,
): Promise<void>;

export function updateDiscordToken(
  envFile: string,
  token: string,
): Promise<void>;
