import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { defaultProviderModel, type Provider } from "@rapi/contracts";

export const providerBinaries: Record<Provider, string> = {
  codex: "/usr/local/bin/codex",
  cursor: "/home/justn/.local/bin/cursor-agent",
  commandcode: "/usr/local/bin/command-code",
};
export function providerEnvironment(
  provider?: Provider,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        (provider === "commandcode" && key === "CMD_API_KEY") ||
        !/TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|PRIVATE_KEY|CURSOR.*(?:AUTH|CREDENTIAL)|CREDENTIAL/i.test(
          key,
        ),
    ),
  );
}
export function buildProviderCommand(
  spec: {
    provider: Provider;
    model?: string | undefined;
    permissions: string[];
  },
  workspace: string,
  reportPath: string,
  prompt: string,
) {
  const { provider, model } = defaultProviderModel(spec);
  const write = spec.permissions.includes("repo:write");
  const modelArgs = model ? ["--model", model] : [];
  const args =
    provider === "codex"
      ? [
          "exec",
          "--ignore-user-config",
          "--ephemeral",
          ...modelArgs,
          ...(write ? ["--approve-for-me"] : ["--sandbox", "read-only"]),
          "--color",
          "never",
          "--output-last-message",
          reportPath,
          "-C",
          workspace,
          "-",
        ]
      : provider === "cursor"
        ? [
            "--print",
            "--output-format",
            "text",
            ...modelArgs,
            ...(write ? ["--force"] : []),
            prompt,
          ]
        : [
            "--print",
            prompt,
            "--output-format",
            "text",
            ...modelArgs,
            ...(write ? ["--yolo"] : []),
            "--no-session",
            "--skip-onboarding",
            "--no-auto-update",
          ];
  return {
    command: providerBinaries[provider],
    args,
    input: provider === "codex" ? prompt : undefined,
    stdoutReport: provider !== "codex",
  };
}
export function providerFailure(provider: Provider, code: number): string {
  const help =
    provider === "commandcode"
      ? "Check CMD_API_KEY in .env and restart the OMP service."
      : provider === "cursor"
        ? "Run cursor-agent login as the OMP service user; check ~/.cursor OAuth credentials."
        : "Run codex login as the OMP service user.";
  return `${provider} exited with status ${code}. Check the redacted omp-execution.log for details. ${help}`;
}
export async function providerReadiness(
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string, mode?: number) => Promise<void> = access,
) {
  let binary = false;
  let configured = false;
  try {
    await exists(providerBinaries[provider], constants.X_OK);
    binary = true;
  } catch {
    /* unavailable */
  }
  if (provider === "commandcode") configured = Boolean(env.CMD_API_KEY?.trim());
  else {
    const config =
      provider === "cursor"
        ? path.join(env.HOME ?? "", ".cursor")
        : path.join(
            env.CODEX_HOME ?? path.join(env.HOME ?? "", ".codex"),
            "auth.json",
          );
    try {
      await exists(config);
      configured = true;
    } catch {
      /* login required */
    }
  }
  return { binary, configured, authentication: "not_verified" as const };
}
export async function assertProviderReady(provider: Provider): Promise<void> {
  const ready = await providerReadiness(provider);
  if (!ready.binary)
    throw new Error(
      `${provider} CLI unavailable: install ${providerBinaries[provider]} for the OMP service user.`,
    );
  if (!ready.configured)
    throw new Error(
      `${provider} authentication configuration missing. ${providerFailure(provider, 1)}`,
    );
}
