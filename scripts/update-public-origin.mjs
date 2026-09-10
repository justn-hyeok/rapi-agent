import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import { replaceEnvironmentValue } from "./update-discord-token.mjs";

const origin = process.argv[2]?.replace(/\/$/, "");
if (!origin) throw new Error("HTTPS origin이 필요합니다.");
const url = new URL(origin);
if (
  url.protocol !== "https:" ||
  url.pathname !== "/" ||
  url.search ||
  url.hash ||
  !/^rapi-[a-z0-9]{12}\.justn\.me$/.test(url.hostname)
)
  throw new Error("공개 주소는 rapi-<랜덤 12자>.justn.me 형식이어야 합니다.");
const target = resolve(process.env.RAPI_ENV_FILE ?? ".env");
const info = await lstat(target);
if (!info.isFile() || info.isSymbolicLink())
  throw new Error("RAPI_ENV_FILE은 일반 파일이어야 합니다.");
const contents = replaceEnvironmentValue(
  await readFile(target, "utf8"),
  "RAPI_PUBLIC_BASE_URL",
  origin,
);
const temporary = `${target}.${process.pid}.tmp`;
try {
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
} catch (error) {
  await unlink(temporary).catch(() => undefined);
  throw error;
}
