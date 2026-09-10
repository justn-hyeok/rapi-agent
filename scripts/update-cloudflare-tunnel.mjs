import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import { replaceEnvironmentValue } from "./update-discord-token.mjs";

const [originValue] = process.argv.slice(2);
const origin = originValue?.replace(/\/$/, "");
if (!origin) throw new Error("A fixed public origin is required");
const url = new URL(origin);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash ||
  url.hostname.endsWith(".trycloudflare.com")
)
  throw new Error(
    "The public origin must be a fixed HTTPS origin without a path",
  );

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const token = Buffer.concat(chunks).toString("utf8");
if (!token || token.length < 20 || /[\r\n\0]/.test(token))
  throw new Error("The Cloudflare tunnel token is invalid");

const target = resolve(process.env.RAPI_ENV_FILE ?? ".env");
const info = await lstat(target);
if (!info.isFile() || info.isSymbolicLink())
  throw new Error("RAPI_ENV_FILE must be a regular file");
let contents = await readFile(target, "utf8");
contents = replaceEnvironmentValue(contents, "RAPI_PUBLIC_BASE_URL", origin);
contents = replaceEnvironmentValue(contents, "CLOUDFLARE_TUNNEL_TOKEN", token);
const temporary = `${target}.${process.pid}.tmp`;
try {
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
} catch (error) {
  await unlink(temporary).catch(() => undefined);
  throw error;
}
process.stdout.write("Cloudflare Named Tunnel configuration saved.\n");
