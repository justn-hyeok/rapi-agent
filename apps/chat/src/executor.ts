import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_CODEX_MODEL,
  redactChat,
  textDigest,
  type GitObservation,
  type RunEvidence,
} from "@rapi/contracts";
import {
  childEnvironment,
  codexHarness,
  selectHarness,
  senpiHarness,
  type Harness,
  type HarnessId,
  type HarnessReadiness,
  withSenpiLoginHint,
} from "./harness.js";
const exec = promisify(execFile);
export const MODEL = DEFAULT_CODEX_MODEL;
export type ProcessResult = {
  exitCode: number | null;
  signal: string | null;
  reason: "exit" | "cancel" | "timeout" | "spawn_error";
  output: string;
  blocked: boolean;
  notice?: string;
};
export function codexEnvironment(): NodeJS.ProcessEnv {
  return childEnvironment();
}
export async function runProcess(
  command: string,
  args: string[],
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  },
): Promise<ProcessResult> {
  if (options.signal.aborted)
    return {
      exitCode: null,
      signal: null,
      reason: "cancel",
      output: "",
      blocked: false,
    };
  return new Promise((resolve) => {
    let reason: ProcessResult["reason"] = "exit";
    let output = "";
    const child = spawn(command, args, {
      detached: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? codexEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Already exited. close is authoritative. */
        }
      }
    };
    const stop = (why: "cancel" | "timeout"): void => {
      if (reason !== "exit") return;
      reason = why;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = (): void => stop("cancel");
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-16000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", () => undefined);
    child.on("error", () => {
      reason = "spawn_error";
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      // Remove descendants even when the parent exits before the grace period.
      kill("SIGKILL");
      options.signal.removeEventListener("abort", abort);
      resolve({
        exitCode,
        signal,
        reason,
        output: redactChat(output),
        blocked:
          /unauthori[sz]ed|authentication|rate.?limit|quota|\b401\b|\b403\b|\b429\b|로그인|인증/.test(
            output,
          ),
      });
    });
    child.stdin.end(options.input ?? "");
  });
}
export async function observeGit(
  repository: string,
): Promise<GitObservation | undefined> {
  try {
    const git = async (...args: string[]): Promise<string> =>
      (
        await exec("git", ["-C", repository, ...args], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    const head = (await git("rev-parse", "HEAD")).trim();
    const status = await git("status", "--porcelain=v1");
    const diff = await git("diff", "HEAD", "--no-ext-diff", "--binary");
    const files = (
      await git("ls-files", "--others", "--exclude-standard", "-z")
    )
      .split("\0")
      .filter(Boolean);
    if (files.length > 100) return undefined;
    const hashes: string[] = [];
    let bytes = 0;
    for (const file of files) {
      const size = (await stat(join(repository, file))).size;
      bytes += size;
      if (bytes > 1024 * 1024) return undefined;
      hashes.push(
        textDigest((await readFile(join(repository, file))).toString("base64")),
      );
    }
    return {
      head,
      status: redactChat(status).slice(0, 4000),
      digest: textDigest(JSON.stringify([head, status, diff, hashes])),
    };
  } catch {
    return undefined;
  }
}
export async function cleanupArtifacts(workspace: string): Promise<void> {
  for (const entry of await readdir(workspace, { withFileTypes: true })) {
    if (entry.isDirectory() && /^run-[a-zA-Z0-9]{6}$/.test(entry.name))
      await rm(join(workspace, entry.name), { recursive: true, force: true });
  }
}
export type ExecuteInput = {
  prompt: string;
  model?: string;
  modelExplicit?: boolean;
  harness?: HarnessId;
  execute: boolean;
  signal: AbortSignal;
  timeoutMs: number;
};
export interface Executor {
  run(input: ExecuteInput): Promise<ProcessResult>;
  observe(): Promise<GitObservation | undefined>;
  readiness?(): Promise<Record<HarnessId, HarnessReadiness>>;
  verify(
    taskDigest: string,
    after: GitObservation,
  ): Promise<RunEvidence["verification"]>;
}
export type ExecutorOptions = {
  harness?: HarnessId;
  harnesses?: Record<HarnessId, Harness>;
  senpiBinary?: string;
  senpiHome?: string;
};
export class CodexExecutor implements Executor {
  private readonly harnesses: Record<HarnessId, Harness>;
  private readonly defaultHarness: HarnessId;
  constructor(
    readonly repository: string,
    readonly workspace: string,
    options: ExecutorOptions = {},
  ) {
    this.defaultHarness = options.harness ?? "codex";
    this.harnesses = options.harnesses ?? {
      codex: codexHarness(MODEL),
      senpi: senpiHarness(options.senpiBinary, options.senpiHome),
    };
  }
  async readiness(): Promise<Record<HarnessId, HarnessReadiness>> {
    return {
      codex: await this.harnesses.codex.readiness(),
      senpi: await this.harnesses.senpi.readiness(),
    };
  }
  observe(): Promise<GitObservation | undefined> {
    return observeGit(this.repository);
  }
  async verify(
    taskDigest: string,
    after: GitObservation,
  ): Promise<RunEvidence["verification"]> {
    const result = await runProcess(
      "git",
      ["-C", this.repository, "diff", "--check"],
      { signal: new AbortController().signal, timeoutMs: 5000 },
    );
    const current = await this.observe();
    if (
      result.exitCode === null ||
      result.reason !== "exit" ||
      current?.digest !== after.digest
    )
      return undefined;
    return {
      command: "git diff --check",
      exitCode: result.exitCode,
      revision: after.digest,
      taskDigest,
    };
  }
  async run(input: ExecuteInput): Promise<ProcessResult> {
    const directory = await mkdtemp(join(this.workspace, "run-"));
    const outputPath = join(directory, "answer.txt");
    try {
      const senpi = await this.harnesses.senpi.readiness();
      const selection = selectHarness({
        execute: input.execute,
        ...(input.harness ? { requested: input.harness } : {}),
        fallback: this.defaultHarness,
        senpiReady: senpi.binary && senpi.configured,
      });
      const harness = this.harnesses[selection.id];
      const model =
        selection.id === "senpi"
          ? input.modelExplicit
            ? input.model
            : undefined
          : (input.model ?? MODEL);
      const built = harness.build({
        prompt: input.prompt,
        ...(model ? { model } : {}),
        execute: input.execute,
        repository: this.repository,
        outputPath,
      });
      const result = await runProcess(built.command, built.args, {
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        env: built.env,
        ...(built.cwd ? { cwd: built.cwd } : {}),
        ...(built.stdin !== undefined ? { input: built.stdin } : {}),
      });
      if (!built.reportFile)
        return {
          ...result,
          ...(selection.id === "senpi"
            ? { output: withSenpiLoginHint(result) }
            : {}),
          ...(selection.notice ? { notice: selection.notice } : {}),
        };
      let output = "";
      try {
        if ((await stat(built.reportFile)).size <= 64000)
          output = redactChat(await readFile(built.reportFile, "utf8")).trim();
      } catch {
        /* Missing output is not completion evidence. */
      }
      return {
        ...result,
        output: output.slice(0, 16000),
        ...(selection.notice ? { notice: selection.notice } : {}),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
