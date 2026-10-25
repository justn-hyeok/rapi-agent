import { loadEnvironment } from "@rapi/config";
import { resolveHomeGuildId } from "@rapi/core";
import { registerSlashCommands } from "../apps/bot/src/discord-http.js";

const config = loadEnvironment();
await registerSlashCommands(
  config.DISCORD_APPLICATION_ID,
  config.DISCORD_BOT_TOKEN,
  resolveHomeGuildId(
    config.DISCORD_HOME_GUILD_ID,
    config.COMMUNITY_GUILD_ID,
    config.DISCORD_ALLOWED_GUILD_IDS,
  ),
);
process.stdout.write("Discord slash commands를 등록했습니다.\n");
