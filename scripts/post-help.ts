import { DiscordLayoutManager } from "@rapi/agent";
import { loadEnvironment } from "@rapi/config";
import { PostgresStore } from "@rapi/db";

// Posts or refreshes the usage guide in #라피-도움말 without a layout apply.
const config = loadEnvironment();
const guildId =
  config.COMMUNITY_GUILD_ID ?? config.DISCORD_ALLOWED_GUILD_IDS?.[0];
if (!guildId)
  throw new Error("COMMUNITY_GUILD_ID 또는 허용 guild ID가 필요합니다.");
const store = new PostgresStore(config.DATABASE_URL, {
  max: 1,
  connectionTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
});
try {
  await new DiscordLayoutManager(store, {
    botToken: config.DISCORD_BOT_TOKEN,
    layoutFile: config.DISCORD_LAYOUT_FILE,
  }).ensureHelpMessage(guildId);
  console.log("도움말을 게시했습니다.");
} finally {
  await store.close();
}
