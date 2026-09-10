import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const PUBLIC_CODEX_MODEL = "gpt-5.3-codex-spark";
// Includes the fixed policy prompt and bounded public-feed context. User input is capped at 4,000.
export const PUBLIC_PROMPT_LIMIT = 16_000;
export const PUBLIC_OUTPUT_LIMIT = 6_000;
export const PUBLIC_TIMEOUT_MS = 60_000;

const disabledFeatures = [
  "shell_tool",
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "multi_agent",
  "image_generation",
  "view_image",
] as const;

export function buildPublicCodexCommand(
  workspace: string,
  outputPath: string,
  binary = "/usr/local/bin/codex",
): { command: string; args: string[] } {
  return {
    command: binary,
    args: [
      "--search",
      "--ask-for-approval",
      "never",
      "exec",
      "--strict-config",
      "--ignore-user-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "--model",
      PUBLIC_CODEX_MODEL,
      "--sandbox",
      "read-only",
      ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
      "--color",
      "never",
      "--output-last-message",
      outputPath,
      "-C",
      workspace,
      "-",
    ],
  };
}

export function publicCodexEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const codexHome = source.CODEX_HOME ?? "/var/lib/rapi-public/codex";
  return {
    ...(source.PATH ? { PATH: source.PATH } : {}),
    ...(source.LANG ? { LANG: source.LANG } : { LANG: "C.UTF-8" }),
    HOME: "/var/lib/rapi-public",
    CODEX_HOME: codexHome,
  };
}

export interface PublicCodexResult {
  started: boolean;
  ok: boolean;
  output: string;
  reason: "exit" | "timeout" | "cancel" | "spawn_error";
}

export async function runPublicCodex(
  prompt: string,
  options: {
    workspace?: string;
    runtimeDirectory?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    binary?: string;
    onStarted?: () => void;
  } = {},
): Promise<PublicCodexResult> {
  const workspace = options.workspace ?? "/var/empty";
  const runtimeDirectory = options.runtimeDirectory ?? "/tmp";
  if (prompt.length === 0 || prompt.length > PUBLIC_PROMPT_LIMIT)
    throw new Error(
      `Public prompt must contain 1-${PUBLIC_PROMPT_LIMIT} characters`,
    );
  await mkdir(runtimeDirectory, { recursive: true });
  const directory = await mkdtemp(join(runtimeDirectory, "rapi-public-"));
  const outputPath = join(directory, "answer.txt");
  const command = buildPublicCodexCommand(
    workspace,
    outputPath,
    options.binary,
  );
  try {
    return await new Promise((resolve) => {
      let started = false;
      let settled = false;
      let reason: PublicCodexResult["reason"] = "exit";
      const child = spawn(command.command, command.args, {
        cwd: workspace,
        env: publicCodexEnvironment(options.env),
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      const finish = async (code: number | null): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        let output = "";
        try {
          if ((await stat(outputPath)).size <= 64_000)
            output = (await readFile(outputPath, "utf8")).trim();
        } catch {
          // A missing final message is an unsuccessful response.
        }
        resolve({
          started,
          ok: reason === "exit" && code === 0 && output.length > 0,
          output: output.slice(0, PUBLIC_OUTPUT_LIMIT),
          reason,
        });
      };
      const kill = (): void => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Already exited.
        }
      };
      const abort = (): void => {
        reason = "cancel";
        kill();
      };
      child.once("spawn", () => {
        started = true;
        options.onStarted?.();
      });
      child.once("error", () => {
        reason = "spawn_error";
        void finish(null);
      });
      child.once("close", (code) => void finish(code));
      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt);
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        reason = "timeout";
        kill();
        setTimeout(() => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // Already exited.
            }
          }
        }, 1_000).unref();
      }, options.timeoutMs ?? PUBLIC_TIMEOUT_MS);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
