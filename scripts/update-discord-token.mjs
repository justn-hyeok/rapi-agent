import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function replaceEnvironmentValue(contents, name, value) {
  if (!value || /[\r\n\0]/.test(value))
    throw new Error("Environment value must be a single non-empty line");
  const assignment = `${name}=${value}`;
  const expression = new RegExp(`^\\s*${name}\\s*=`);
  const lines = contents.split(/\r?\n/);
  const output = [];
  let replaced = false;
  for (const line of lines) {
    if (!expression.test(line)) {
      output.push(line);
      continue;
    }
    if (!replaced) {
      output.push(assignment);
      replaced = true;
    }
  }
  if (output.at(-1) === "") output.pop();
  if (!replaced) output.push(assignment);
  return `${output.join("\n")}\n`;
}

export async function validateDiscordBotToken(token, request = fetch) {
  if (!/^[A-Za-z0-9._-]{20,256}$/.test(token))
    throw new Error("Discord bot token format is invalid");
  const response = await request("https://discord.com/api/v10/users/@me", {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bot ${token}` },
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(`Discord rejected the token with HTTP ${response.status}`);
  }
  const account = await response.json();
  if (!account || typeof account !== "object" || account.bot !== true)
    throw new Error("The supplied credential is not a Discord bot token");
}

export async function updateDiscordToken(envFile, token) {
  await validateDiscordBotToken(token);
  const target = resolve(envFile);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("RAPI_ENV_FILE must be a regular file");
  const updated = replaceEnvironmentValue(
    await readFile(target, "utf8"),
    "DISCORD_BOT_TOKEN",
    token,
  );
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  const token = await readStandardInput();
  await updateDiscordToken(process.env.RAPI_ENV_FILE ?? ".env", token);
  process.stdout.write("Discord token verified and .env updated.\n");
}
