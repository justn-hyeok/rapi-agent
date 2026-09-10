import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { replaceEnvironmentValue } from "./update-discord-token.mjs";

const input = process.argv.slice(2);
const pairs =
  input[0] === "--from-file"
    ? [
        input[1],
        (await readFile(resolve(input[2]), "utf8")).replace(/\r?\n$/, ""),
        ...input.slice(3),
      ]
    : input;
if (pairs.length === 0 || pairs.length % 2 !== 0)
  throw new Error("NAME VALUE 쌍이 필요합니다.");
const target = resolve(process.env.RAPI_ENV_FILE ?? ".env");
const info = await lstat(target);
if (!info.isFile() || info.isSymbolicLink())
  throw new Error("RAPI_ENV_FILE은 일반 파일이어야 합니다.");
let contents = await readFile(target, "utf8");
for (let index = 0; index < pairs.length; index += 2)
  contents = replaceEnvironmentValue(contents, pairs[index], pairs[index + 1]);
const temporary = `${target}.${process.pid}.tmp`;
try {
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
} catch (error) {
  await unlink(temporary).catch(() => undefined);
  throw error;
}
