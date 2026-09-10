const token = process.env.DISCORD_BOT_TOKEN;
const origin = process.env.RAPI_PUBLIC_BASE_URL?.replace(/\/$/, "");
if (!token || !origin)
  throw new Error("Discord token과 공개 주소가 필요합니다.");
const endpoint = `${origin}/interactions`;
const response = await fetch("https://discord.com/api/v10/applications/@me", {
  method: "PATCH",
  redirect: "manual",
  signal: AbortSignal.timeout(10_000),
  headers: {
    authorization: `Bot ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ interactions_endpoint_url: endpoint }),
});
await response.arrayBuffer();
if (!response.ok)
  throw new Error(
    `Discord interaction endpoint 설정 실패: HTTP ${response.status}`,
  );
process.stdout.write(
  `Discord interaction endpoint를 ${endpoint}로 설정했습니다.\n`,
);
