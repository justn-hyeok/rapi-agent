import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvironment } from "@rapi/config";
import { PostgresStore } from "@rapi/db";
import { replaceEnvironmentValue } from "./update-discord-token.mjs";

export function publicCommunityEnvironment(
  guildId: string,
  resources: Record<string, string | null>,
): Record<string, string> {
  if (!/^\d+$/.test(guildId))
    throw new Error("Valid community guild ID required");
  for (const key of ["user", "staff", "admin", "questions", "alerts"])
    if (!resources[key] || !/^\d+$/.test(resources[key]))
      throw new Error(`Managed community resource is missing: ${key}`);
  if (resources.user === resources.staff)
    throw new Error("USER and ADMIN roles must be distinct");
  if (resources.admin === resources.questions)
    throw new Error("Public and administrator channels must be distinct");
  return {
    COMMUNITY_GUILD_ID: guildId,
    DISCORD_GUILD_MEMBERS_ARE_USERS: "false",
    DISCORD_USER_ROLE_IDS: resources.user!,
    DISCORD_ADMIN_ROLE_IDS: resources.staff!,
    RAPI_ADMIN_CHANNEL_ID: resources.admin!,
    OPERATIONS_CHANNEL_ID: resources.alerts!,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && !["--preview", "--apply"].includes(args[0]!))
  )
    throw new Error("Use --preview or --apply");
  const apply = args[0] === "--apply";
  if (apply && process.env.RAPI_COMMUNITY_APPROVED !== "true")
    throw new Error("Explicit operational approval is required");
  const config = loadEnvironment();
  const guildId =
    config.COMMUNITY_GUILD_ID ?? config.DISCORD_ALLOWED_GUILD_IDS?.[0];
  if (!guildId || !config.DISCORD_ALLOWED_GUILD_IDS?.includes(guildId))
    throw new Error("Community guild must already be allowlisted");
  const store = new PostgresStore(config.DATABASE_URL, {
    max: 1,
    connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
    queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
  });
  try {
    const resources = Object.fromEntries(
      await Promise.all(
        (
          [
            ["user", "role", "rapi_user"],
            ["staff", "role", "rapi_staff"],
            ["admin", "channel", "rapi_admin"],
            ["questions", "channel", "rapi_questions"],
            ["alerts", "channel", "operations_alerts"],
          ] as const
        ).map(
          async ([name, type, key]): Promise<[string, string | null]> => [
            name,
            await store.managedDiscordResourceId(guildId, type!, key!),
          ],
        ),
      ),
    );
    const updates = publicCommunityEnvironment(guildId, resources);
    if (apply) {
      const target = resolve(process.env.RAPI_ENV_FILE ?? ".env");
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Environment target must be a regular file");
      let content = await readFile(target, "utf8");
      for (const [name, value] of Object.entries(updates))
        content = replaceEnvironmentValue(content, name, value);
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    }
    process.stdout.write(
      `${JSON.stringify({ guildId, applied: apply, updates }, null, 2)}\n`,
    );
  } finally {
    await store.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
