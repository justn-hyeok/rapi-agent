import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDiscordLayout, serializeDiscordLayout } from "@rapi/agent";

const source = process.argv[2];
const target = resolve(
  process.env.DISCORD_LAYOUT_FILE ?? "config/discord-channels.yaml",
);
if (!source) throw new Error("가져올 YAML 또는 JSON 파일 경로가 필요합니다.");
const layout = parseDiscordLayout(await readFile(resolve(source), "utf8"));
const temporary = `${target}.${process.pid}.tmp`;
try {
  await writeFile(temporary, serializeDiscordLayout(layout, "yaml"), {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
} catch (error) {
  await unlink(temporary).catch(() => undefined);
  throw error;
}
process.stdout.write(
  `Discord 구성을 ${target}에 가져왔습니다. 미리보기 후 적용하세요.\n`,
);
