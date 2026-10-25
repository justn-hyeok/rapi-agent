import { learnerGuideMessage } from "@rapi/agent";
import { loadEnvironment } from "@rapi/config";

const channelId = process.argv[2];
if (!channelId || !/^\d+$/.test(channelId))
  throw new Error("사용법: npm run learner:post-guide -- <채널 ID>");
const config = loadEnvironment();
const response = await fetch(
  `https://discord.com/api/v10/channels/${channelId}/messages`,
  {
    method: "POST",
    headers: {
      authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...learnerGuideMessage(),
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(10_000),
  },
);
if (!response.ok)
  throw new Error(
    `안내 메시지를 올리지 못했습니다: Discord ${response.status}`,
  );
process.stdout.write("학습자 소식 안내 메시지를 올렸습니다.\n");
