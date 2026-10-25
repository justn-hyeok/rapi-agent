import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitHubAppClient } from "@rapi/adapters";
import { redactChat, type ChatRun } from "@rapi/contracts";
import {
  assertPullRequestBranch,
  githubScope,
  parseGitHubChannel,
  type GitHubAccessPolicy,
  type GitHubRequest,
} from "@rapi/core";
import type { GitHubDelivery, GitHubStore } from "@rapi/db";
import { CodexExecutor, observeGit, type ExecutorOptions } from "./executor.js";
import { childEnvironment } from "./harness.js";
import type { ScopeWorkspace, WorkspaceResolver } from "./orchestrator.js";

const exec = promisify(execFile);

type App = Pick<
  GitHubAppClient,
  "installationFor" | "token" | "comment" | "react" | "createPullRequest"
>;

/** git with a one-shot auth header in the environment: never stored in the clone or argv. */
async function git(
  cwd: string | undefined,
  args: string[],
  token?: string,
  timeout = 120_000,
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...childEnvironment(),
    GIT_TERMINAL_PROMPT: "0",
  };
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  const result = await exec("git", args, {
    ...(cwd ? { cwd } : {}),
    env,
    timeout,
    maxBuffer: 4_000_000,
  });
  return result.stdout;
}

export const GITHUB_CLONE_ROOT = "github";

export async function cleanupGithubClones(workspace: string): Promise<void> {
  const root = join(workspace, GITHUB_CLONE_ROOT);
  for (const entry of await readdir(root).catch(() => [] as string[]))
    await rm(join(root, entry), { recursive: true, force: true });
}

const GITHUB_POLICY = [
  "현재 작업 디렉터리는 이 저장소의 새 클론이다. 필요한 파일만 이 디렉터리 안에서 수정한다.",
  "git commit, branch, push, 원격 설정 변경을 하지 않는다. 변경은 라피가 별도 브랜치의 PR로 올린다.",
  "질문이면 코드를 바꾸지 말고 답만 한다. 검사를 실행했다면 실제 결과를 보고한다.",
].join(" ");

export interface GitHubWorkspaceOptions {
  app: App;
  store: Pick<GitHubStore, "linkRun" | "setPullRequest">;
  policy: GitHubAccessPolicy;
  workspace: string;
  executorOptions: ExecutorOptions;
}

/** Fresh clone per run; the result leaves only as a rapi/* branch PR. */
export function githubWorkspaces(
  options: GitHubWorkspaceOptions,
): WorkspaceResolver {
  return async (scope, route, run) => {
    const target = parseGitHubChannel(scope.channel);
    if (!target) return undefined;
    const { repo, number } = target;
    const installation = await options.app.installationFor(repo);
    if (
      !options.policy.allowedOwners.some(
        (owner) => owner.toLowerCase() === installation.account.toLowerCase(),
      )
    )
      throw new Error("installation owner not allowed");
    const token = await options.app.token(installation.id, repo);
    const root = join(options.workspace, GITHUB_CLONE_ROOT);
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "clone-"));
    try {
      await git(
        undefined,
        ["clone", "--depth", "50", `https://github.com/${repo}.git`, directory],
        token,
      );
      const defaultBranch = (
        await git(directory, ["symbolic-ref", "--short", "HEAD"])
      ).trim();
      if (run)
        await options.store.linkRun(run.id, run.message_id, repo, number);
      const workspace: ScopeWorkspace = {
        executor: new CodexExecutor(
          directory,
          options.workspace,
          options.executorOptions,
        ),
        policy: GITHUB_POLICY,
        dispose: () => rm(directory, { recursive: true, force: true }),
        ...(route === "answer"
          ? {}
          : {
              finalize: ({ run: finished, output }) =>
                openPullRequest({
                  ...options,
                  directory,
                  repo,
                  number,
                  installationId: installation.id,
                  defaultBranch,
                  run: finished,
                  output,
                }),
            }),
      };
      return workspace;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  };
}

export async function openPullRequest(input: {
  app: App;
  store: Pick<GitHubStore, "setPullRequest">;
  directory: string;
  repo: string;
  number: number;
  installationId: number;
  defaultBranch: string;
  run: ChatRun;
  output: string;
}): Promise<string> {
  const observed = await observeGit(input.directory);
  if (!observed?.status.trim())
    return "변경된 파일이 없어 PR을 열지 않았습니다.";
  const branch = `rapi/${input.run.id.slice(0, 8)}`;
  assertPullRequestBranch(branch, input.defaultBranch);
  const identity = [
    "-c",
    "user.name=rapi[bot]",
    "-c",
    "user.email=rapi-bot@users.noreply.github.com",
  ];
  await git(input.directory, ["checkout", "-b", branch]);
  await git(input.directory, ["add", "-A"]);
  await git(input.directory, [
    ...identity,
    "commit",
    "-m",
    `Rapi: ${input.repo}#${input.number} 요청 처리`,
  ]);
  const token = await input.app.token(input.installationId, input.repo);
  // The refspec names the rapi/* branch explicitly; the default branch is never a target.
  await git(
    input.directory,
    ["push", "origin", `HEAD:refs/heads/${branch}`],
    token,
  );
  const url = await input.app.createPullRequest(
    input.installationId,
    input.repo,
    {
      head: branch,
      base: input.defaultBranch,
      title: `Rapi: #${input.number} 요청 처리`,
      body: redactChat(
        [
          `https://github.com/${input.repo}/issues/${input.number} 에서 요청한 작업입니다.`,
          `작업 ${input.run.id}`,
          "",
          "실행기 보고(목표 검증 미확정):",
          input.output.slice(0, 8000),
        ].join("\n"),
      ),
    },
  );
  await input.store.setPullRequest(input.run.id, url);
  return `PR을 열었습니다: ${url}\n머지 전에 변경 내용을 확인해주세요.`;
}

/** `send` target for `github:` channels: posts an issue/PR comment. */
export function githubSender(
  app: Pick<GitHubAppClient, "installationFor" | "comment">,
): (channel: string, text: string) => Promise<void> {
  const installations = new Map<string, number>();
  return async (channel, text) => {
    const target = parseGitHubChannel(channel);
    if (!target) throw new Error("not a GitHub channel");
    let id = installations.get(target.repo);
    if (id === undefined) {
      id = (await app.installationFor(target.repo)).id;
      installations.set(target.repo, id);
    }
    await app.comment(id, target.repo, target.number, redactChat(text));
  };
}

export interface IntakeChat {
  submit(
    scope: ReturnType<typeof githubScope>,
    messageId: string,
    request: string,
    accessLevel: "superadmin",
  ): Promise<void>;
}

/** Drains the webhook inbox into the shared ChatOps engine. */
export class GitHubIntake {
  constructor(
    private readonly ports: {
      store: Pick<GitHubStore, "claimNext" | "finish">;
      app: Pick<GitHubAppClient, "installationFor" | "react" | "comment">;
      chat: IntakeChat;
      policy: GitHubAccessPolicy;
    },
  ) {}

  /** Claims one delivery. The run itself continues in the background so a later `@rapi 멈춰` can be read. */
  async runOnce(): Promise<boolean> {
    const delivery = await this.ports.store.claimNext();
    if (!delivery) return false;
    try {
      await this.start(delivery);
    } catch {
      await this.ports.store.finish(delivery.deliveryId, "failed");
    }
    return true;
  }

  private async start(delivery: GitHubDelivery): Promise<void> {
    const request: GitHubRequest = delivery.request;
    const { app, policy } = this.ports;
    const installation = await app.installationFor(request.repo);
    const allowed = policy.allowedOwners.some(
      (owner) => owner.toLowerCase() === installation.account.toLowerCase(),
    );
    const commenter = policy.ownerLogins.some(
      (login) => login.toLowerCase() === request.login.toLowerCase(),
    );
    if (!allowed || !commenter) throw new Error("not authorized");
    await app
      .react(installation.id, request.repo, {
        commentId: request.commentId,
        number: request.number,
        review: request.event === "pull_request_review_comment",
      })
      .catch(() => undefined);
    if (!request.text) {
      await app.comment(
        installation.id,
        request.repo,
        request.number,
        "무엇을 도와드릴까요? `@rapi` 뒤에 요청을 함께 적어주세요.",
      );
      await this.ports.store.finish(delivery.deliveryId, "done");
      return;
    }
    void this.ports.chat
      .submit(
        githubScope(request),
        request.sourceId,
        request.text,
        "superadmin",
      )
      .then(() => this.ports.store.finish(delivery.deliveryId, "done"))
      .catch(() => this.ports.store.finish(delivery.deliveryId, "failed"))
      .catch(() => undefined);
  }
}
