import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HarnessUpdateRecord } from "@rapi/db";
import {
  bumpManifest,
  HarnessUpdateService,
  type HarnessCheck,
  type HarnessManifest,
  type HarnessUpdatePorts,
  type ReleaseInfo,
} from "./harness-updates.js";

export const ISOLATED_SETTINGS = {
  enableInstallTelemetry: false,
  defaultProjectTrust: "never",
} as const;
export const SMOKE_PROMPT = "Reply with exactly: RAPI_SMOKE_OK";

/** Parses `sha256sum` output into name → hex digest. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

export class GitHubReleases {
  constructor(private readonly token?: string) {}

  async latest(repo: string): Promise<ReleaseInfo | null> {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "rapi-agent",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 404) {
      await response.arrayBuffer();
      return null;
    }
    if (!response.ok) {
      await response.arrayBuffer();
      throw new Error(`GitHub releases 조회 실패 (${response.status})`);
    }
    const release = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string | null;
      assets?: { name?: string; browser_download_url?: string }[];
    };
    if (!release.tag_name) return null;
    return {
      version: release.tag_name.replace(/^v/, ""),
      url: release.html_url ?? `https://github.com/${repo}/releases`,
      body: release.body ?? "",
      assets: (release.assets ?? []).flatMap((asset) =>
        asset.name && asset.browser_download_url
          ? [{ name: asset.name, url: asset.browser_download_url }]
          : [],
      ),
    };
  }
}

type Exec = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs: number;
  },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const run: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        timeout: options.timeoutMs,
        maxBuffer: 4_000_000,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
    child.stdin?.end(options.input ?? "");
  });

const SECRET_KEY = /TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|PRIVATE_KEY/i;
const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !SECRET_KEY.test(key)),
  ),
  ...extra,
});

async function timed(
  name: HarnessCheck["name"],
  work: () => Promise<{ ok: boolean; detail: string }>,
): Promise<HarnessCheck> {
  const started = Date.now();
  try {
    return { name, ...(await work()), durationMs: Date.now() - started };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 200) : "실패",
      durationMs: Date.now() - started,
    };
  }
}

async function download(url: string, to: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) {
    await response.arrayBuffer();
    throw new Error(`다운로드 실패 (${response.status})`);
  }
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createWriteStream(to),
  );
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function filesUnder(directory: string, limit = 4000): Promise<string[]> {
  const found: string[] = [];
  const queue = [directory];
  while (queue.length && found.length < limit) {
    const current = queue.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  return found;
}

/** True when every key still appears somewhere in the unpacked release. */
export async function settingKeysPresent(
  directory: string,
  keys: string[],
): Promise<{ missing: string[] }> {
  const missing = new Set(keys);
  for (const file of await filesUnder(directory)) {
    if (!missing.size) break;
    if ((await stat(file)).size > 400_000_000) continue;
    const content = (await readFile(file)).toString("latin1");
    for (const key of [...missing])
      if (content.includes(key)) missing.delete(key);
  }
  return { missing: [...missing] };
}

export interface SandboxOptions {
  /** Live agent directory whose credentials let the smoke prompt log in. */
  liveAgentDirectory?: string;
  smokeTimeoutMs?: number;
  exec?: Exec;
  download?: (url: string, to: string) => Promise<void>;
}

/** Evaluates a release in a temp directory that never touches the live install. */
export class SandboxEvaluator {
  constructor(private readonly options: SandboxOptions = {}) {}

  async run(
    update: HarnessUpdateRecord,
    release: ReleaseInfo | null,
  ): Promise<{ checks: HarnessCheck[]; sha256: string | null }> {
    const exec = this.options.exec ?? run;
    const fetchTo = this.options.download ?? download;
    const checks: HarnessCheck[] = [];
    const work = await mkdtemp(join(tmpdir(), "rapi-harness-update-"));
    let sha256: string | null = null;
    try {
      const archive = join(work, update.asset);
      const sha = await timed("sha256", async () => {
        if (!release) throw new Error("릴리스를 다시 조회하지 못했습니다.");
        const asset = release.assets.find((a) => a.name === update.asset);
        const sums = release.assets.find((a) =>
          /^sha256sums(\.txt)?$/i.test(a.name),
        );
        if (!asset) throw new Error(`${update.asset} 자산이 없습니다.`);
        if (!sums) throw new Error("SHA256SUMS 자산이 없습니다.");
        await fetchTo(asset.url, archive);
        const sumsFile = join(work, "SHA256SUMS");
        await fetchTo(sums.url, sumsFile);
        const expected = parseChecksums(await readFile(sumsFile, "utf8")).get(
          update.asset,
        );
        if (!expected) throw new Error("SHA256SUMS에 이 자산이 없습니다.");
        const actual = await sha256File(archive);
        if (actual !== expected)
          throw new Error("내려받은 파일의 sha256이 SHA256SUMS와 다릅니다.");
        sha256 = actual;
        return {
          ok: true,
          detail: `SHA256SUMS와 일치 (${actual.slice(0, 12)}…)`,
        };
      });
      checks.push(sha);
      if (!sha.ok) return { checks, sha256: null };

      const unpacked = join(work, "unpacked");
      const agentDirectory = join(work, "agent");
      const empty = join(work, "cwd");
      await Promise.all(
        [unpacked, agentDirectory, empty].map((d) => mkdir(d, { mode: 0o700 })),
      );
      const untar = await exec("tar", ["-xzf", archive, "-C", unpacked], {
        timeoutMs: 120_000,
      });
      if (untar.code !== 0) {
        checks.push({
          name: "version",
          ok: false,
          detail: "압축 해제 실패",
          durationMs: 0,
        });
        return { checks, sha256 };
      }
      await writeFile(
        join(agentDirectory, "settings.json"),
        `${JSON.stringify(ISOLATED_SETTINGS)}\n`,
        { mode: 0o600 },
      );
      const live = this.options.liveAgentDirectory;
      if (live)
        for (const entry of await readdir(live, { withFileTypes: true }).catch(
          () => [],
        ))
          if (entry.isFile() && entry.name !== "settings.json")
            await copyFile(
              join(live, entry.name),
              join(agentDirectory, entry.name),
            ).catch(() => undefined);

      const binary = join(unpacked, "pi", "pi");
      const env = childEnv({
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
      });
      checks.push(
        await timed("version", async () => {
          const result = await exec(binary, ["--version"], {
            env,
            cwd: empty,
            timeoutMs: 30_000,
          });
          const reported = result.stdout.trim().split("\n")[0] ?? "";
          if (result.code !== 0)
            throw new Error(`--version 종료 코드 ${result.code}`);
          return { ok: true, detail: reported.slice(0, 80) || "실행됨" };
        }),
        await timed("settings", async () => {
          const { missing } = await settingKeysPresent(
            unpacked,
            Object.keys(ISOLATED_SETTINGS),
          );
          if (missing.length)
            throw new Error(
              `새 버전에서 설정 키를 찾지 못했습니다: ${missing.join(", ")}`,
            );
          const result = await exec(binary, ["--version"], {
            env,
            cwd: empty,
            timeoutMs: 30_000,
          });
          if (/unknown (?:setting|option)|invalid setting/i.test(result.stderr))
            throw new Error("새 버전이 격리 설정을 거부했습니다.");
          return {
            ok: true,
            detail: "텔레메트리 끔·프로젝트 신뢰 never 키 유지",
          };
        }),
        await timed("smoke", async () => {
          const result = await exec(
            binary,
            ["-p", "--no-session", "--no-approve"],
            {
              env,
              cwd: empty,
              input: SMOKE_PROMPT,
              timeoutMs: this.options.smokeTimeoutMs ?? 120_000,
            },
          );
          if (result.code !== 0) throw new Error(`종료 코드 ${result.code}`);
          if (!result.stdout.includes("RAPI_SMOKE_OK"))
            throw new Error("응답에 기대한 문구가 없습니다.");
          return { ok: true, detail: "고정 프롬프트 응답 확인" };
        }),
      );
      return { checks, sha256 };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

export interface GitOptions {
  repo: string;
  baseBranch: string;
  manifestPath?: string;
  exec?: Exec;
}

/** Opens PRs through the gh CLI that is already logged in on the VM. */
export class GhPullRequests {
  constructor(private readonly options: GitOptions) {}

  private get exec(): Exec {
    return this.options.exec ?? run;
  }

  async pullRequestState(url: string): Promise<"open" | "merged" | "closed"> {
    const result = await this.exec(
      "gh",
      ["pr", "view", url, "--json", "state"],
      { timeoutMs: 30_000, env: childEnv() },
    );
    if (result.code !== 0) throw new Error("PR 상태를 읽지 못했습니다.");
    const state = (JSON.parse(result.stdout) as { state?: string }).state;
    return state === "MERGED" ? "merged" : state === "OPEN" ? "open" : "closed";
  }

  async openPullRequest(
    input: Parameters<HarnessUpdatePorts["git"]["openPullRequest"]>[0],
  ): Promise<{ url: string }> {
    const { repo, baseBranch } = this.options;
    const manifestPath =
      this.options.manifestPath ?? "ops/harness-versions.json";
    const env = childEnv({ GIT_TERMINAL_PROMPT: "0" });
    const existing = await this.exec(
      "gh",
      [
        "pr",
        "list",
        "-R",
        repo,
        "--head",
        input.branch,
        "--state",
        "open",
        "--json",
        "url",
      ],
      { timeoutMs: 30_000, env },
    );
    if (existing.code === 0) {
      const open = (
        JSON.parse(existing.stdout || "[]") as { url: string }[]
      )[0];
      if (open) return { url: open.url };
    }
    const work = await mkdtemp(join(tmpdir(), "rapi-harness-pr-"));
    try {
      const dir = join(work, "repo");
      const step = async (command: string, args: string[], cwd?: string) => {
        const result = await this.exec(command, args, {
          ...(cwd ? { cwd } : {}),
          env,
          timeoutMs: 180_000,
        });
        if (result.code !== 0)
          throw new Error(
            `${command} ${args[0] ?? ""} 실패: ${result.stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""}`,
          );
        return result.stdout;
      };
      await step("gh", [
        "repo",
        "clone",
        repo,
        dir,
        "--",
        "--depth",
        "1",
        "--branch",
        baseBranch,
      ]);
      const path = join(dir, manifestPath);
      await writeFile(
        path,
        bumpManifest(
          await readFile(path, "utf8"),
          input.update.harness,
          input.expectedCurrent,
          input.next,
        ),
      );
      const identity = [
        "-c",
        "user.name=Rapi",
        "-c",
        "user.email=rapi@users.noreply.github.com",
      ];
      await step("git", ["checkout", "-b", input.branch], dir);
      await step("git", ["add", manifestPath], dir);
      await step("git", [...identity, "commit", "-m", input.title], dir);
      await step(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "push",
          "-u",
          "origin",
          input.branch,
        ],
        dir,
      );
      const body = join(work, "body.md");
      await writeFile(body, input.body);
      const created = await step("gh", [
        "pr",
        "create",
        "-R",
        repo,
        "--base",
        baseBranch,
        "--head",
        input.branch,
        "--title",
        input.title,
        "--body-file",
        body,
      ]);
      const url = created.trim().split("\n").pop() ?? "";
      if (!/^https:\/\/github\.com\//.test(url))
        throw new Error("PR 주소를 읽지 못했습니다.");
      return { url };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

/** Builds the service only when the flag is on and a SUPERADMIN can be asked. */
export function createHarnessUpdates(
  config: {
    HARNESS_UPDATES_ENABLED: boolean;
    HARNESS_UPDATES_REPO: string;
    HARNESS_UPDATES_BASE_BRANCH: string;
    DISCORD_SUPERADMIN_USER_IDS?: string[] | undefined;
    GITHUB_READ_TOKEN?: string | undefined;
    SENPI_HOME: string;
  },
  store: HarnessUpdatePorts["store"],
  delivery: HarnessUpdatePorts["delivery"],
  root = process.cwd(),
): HarnessUpdateService | undefined {
  if (
    !config.HARNESS_UPDATES_ENABLED ||
    !config.DISCORD_SUPERADMIN_USER_IDS?.length
  )
    return undefined;
  return new HarnessUpdateService(
    {
      store,
      delivery,
      releases: new GitHubReleases(config.GITHUB_READ_TOKEN),
      evaluator: new SandboxEvaluator({
        liveAgentDirectory: join(config.SENPI_HOME, "agent"),
      }),
      git: new GhPullRequests({
        repo: config.HARNESS_UPDATES_REPO,
        baseBranch: config.HARNESS_UPDATES_BASE_BRANCH,
      }),
      readManifest: async () =>
        JSON.parse(
          await readFile(join(root, "ops/harness-versions.json"), "utf8"),
        ) as HarnessManifest,
    },
    { superadminIds: config.DISCORD_SUPERADMIN_USER_IDS },
  );
}
