import { access, constants } from "node:fs/promises";
import { join } from "node:path";

export type HarnessId = "codex" | "senpi";
export type HarnessInput = {
  prompt: string;
  model?: string;
  execute: boolean;
  repository: string;
  outputPath: string;
};
export type HarnessCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  stdin?: string;
  reportFile?: string;
};
export type HarnessReadiness = { binary: boolean; configured: boolean };
export interface Harness {
  readonly id: HarnessId;
  build(input: HarnessInput): HarnessCommand;
  readiness(): Promise<HarnessReadiness>;
}

export const DEFAULT_CODEX_BIN = "/usr/local/bin/codex";
export const DEFAULT_SENPI_BIN = "/usr/local/bin/senpi";
export const DEFAULT_SENPI_HOME = "/var/lib/rapi/senpi";

export function childEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|PRIVATE_KEY/i.test(key),
    ),
  );
}

async function exists(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

export function codexHarness(
  defaultModel: string,
  binary = DEFAULT_CODEX_BIN,
): Harness {
  return {
    id: "codex",
    build: (input) => ({
      command: binary,
      args: [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--model",
        input.model ?? defaultModel,
        ...(input.execute
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : ["--sandbox", "read-only"]),
        "--color",
        "never",
        "--output-last-message",
        input.outputPath,
        "-C",
        input.repository,
        "-",
      ],
      env: childEnvironment(),
      stdin: input.prompt,
      reportFile: input.outputPath,
    }),
    readiness: async () => ({
      binary: await exists(binary, constants.X_OK),
      configured: true,
    }),
  };
}

// senpi has no sandbox, so it is only built for owner execution runs.
export function senpiHarness(
  binary = DEFAULT_SENPI_BIN,
  home = DEFAULT_SENPI_HOME,
): Harness {
  const agentDirectory = join(home, "agent");
  return {
    id: "senpi",
    build: (input) => {
      if (!input.execute)
        throw new Error("senpi has no sandbox and cannot run read-only work");
      return {
        command: binary,
        args: [
          "-p",
          "--no-session",
          "--no-approve",
          ...(input.model ? ["--model", input.model] : []),
        ],
        env: {
          ...childEnvironment(),
          PI_CODING_AGENT_DIR: agentDirectory,
          PI_TELEMETRY: "0",
          PI_SKIP_VERSION_CHECK: "1",
        },
        cwd: input.repository,
        stdin: input.prompt,
      };
    },
    readiness: async () => ({
      binary: await exists(binary, constants.X_OK),
      configured: await exists(
        join(agentDirectory, "settings.json"),
        constants.R_OK,
      ),
    }),
  };
}

export type HarnessSelection = { id: HarnessId; notice?: string };

export function selectHarness(options: {
  execute: boolean;
  requested?: HarnessId;
  fallback: HarnessId;
  senpiReady: boolean;
}): HarnessSelection {
  const wanted = options.requested ?? options.fallback;
  if (wanted !== "senpi") return { id: "codex" };
  if (!options.execute)
    return {
      id: "codex",
      ...(options.requested
        ? {
            notice:
              "senpi는 샌드박스가 없어 읽기 전용 답변에는 쓰지 않습니다. Codex로 답했습니다.",
          }
        : {}),
    };
  if (!options.senpiReady)
    return {
      id: "codex",
      notice: "senpi가 준비되지 않아 Codex로 실행했습니다.",
    };
  return { id: "senpi" };
}

// Owner-only per-request override: "센파이로 ..." or "senpi: ...".
export function parseHarnessDirective(input: string): {
  harness?: "senpi";
  task: string;
} {
  const match = input
    .trim()
    .match(/^(?:센파이로|senpi\s*[:：])\s*[,，]?\s*([\s\S]+)$/i);
  return match ? { harness: "senpi", task: match[1]!.trim() } : { task: input };
}

// Only the owner (superadmin) may pick the harness; others' prefix stays plain text.
export function ownerHarnessDirective(
  input: string,
  accessLevel: string,
): { harness?: "senpi"; task: string } {
  return accessLevel === "superadmin"
    ? parseHarnessDirective(input)
    : { task: input };
}

// Owner-only blog draft request: "블로그 초안: 주제" or "blog draft: topic".
export function parseBlogDraftDirective(input: string): string | null {
  const match = input
    .trim()
    .match(/^(?:블로그\s*초안|blog\s*draft)\s*[:：]\s*([\s\S]*)$/i);
  return match ? match[1]!.trim() : null;
}
