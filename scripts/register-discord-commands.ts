import { loadEnvironment } from "@rapi/config";
import { registerSlashCommands } from "../apps/bot/src/discord-http.js";

const config = loadEnvironment();
await registerSlashCommands(
  config.DISCORD_APPLICATION_ID,
  config.DISCORD_BOT_TOKEN,
  config.DISCORD_ALLOWED_GUILD_IDS?.[0],
);
process.stdout.write("Discord slash commands를 등록했습니다.\n");
