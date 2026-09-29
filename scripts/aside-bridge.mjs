import { execFile } from "node:child_process";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { browserCode, parseBrowserOutput } from "./aside-browser.mjs";

const execute = promisify(execFile);
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
if (
  !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/.test(config.sshHost) ||
  !config.asideBinary?.startsWith("/") ||
  !config.statusFile?.startsWith("/") ||
  !config.instructions?.startsWith("/") ||
  !config.mechanics?.startsWith("/")
)
  throw new Error("Invalid Aside bridge configuration");

async function remote(request) {
  // Static command: no request data is interpolated into shell syntax.
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        config.sshHost,
        "cd /home/justn/rapi-releases/current && /usr/local/bin/node --env-file=/home/justn/rapi-agent/.env --import tsx scripts/aside-receiver.ts",
      ],
      { timeout: 40_000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        }
      },
    );
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(request));
  });
}

let claim;
let status = { state: "idle", checkedAt: new Date().toISOString() };
try {
  claim = await remote({ action: "claim" });
  if (claim) {
    if (
      claim.adapter !== "hacker-news-v1" ||
      claim.locator !== "https://news.ycombinator.com/"
    )
      throw new Error("Unknown approved Aside source");
    // Refresh instructions and live CLI help before every browser operation.
    await readFile(config.instructions, "utf8");
    await readFile(config.mechanics, "utf8");
    await execute(config.asideBinary, ["repl", "--help"], { timeout: 10_000 });
    const marker = `RAPI_ASIDE_${randomBytes(16).toString("hex")}:`;
    const { stdout } = await execute(
      config.asideBinary,
      ["repl", browserCode(marker)],
      { timeout: 60_000, maxBuffer: 256 * 1024 },
    );
    const captured = parseBrowserOutput(stdout, marker);
    const result = await remote({
      action: "complete",
      snapshot: {
        ...captured,
        sourceId: claim.sourceId,
        token: claim.token,
        adapter: claim.adapter,
      },
    });
    status = {
      state: "success",
      checkedAt: new Date().toISOString(),
      ...result,
    };
  }
} catch {
  if (claim?.sourceId && claim?.token)
    await remote({
      action: "fail",
      sourceId: claim.sourceId,
      token: claim.token,
    }).catch(() => undefined);
  status = { state: "failed", checkedAt: new Date().toISOString() };
  process.exitCode = 1;
} finally {
  const path = resolve(config.statusFile);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(status) + "\n", { mode: 0o600 });
  await rename(temporary, path);
  process.stdout.write(JSON.stringify(status) + "\n");
}
