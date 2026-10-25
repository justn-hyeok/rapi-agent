import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelClient } from "@rapi/adapters";
import { learnerItemFromPost, type DeliveryAdapter } from "@rapi/core";
import type { BlogPostsStore, PostgresStore } from "@rapi/db";
import {
  BlogService,
  type BlogPublisher,
  type BlogTopic,
  type BlogWithdrawals,
} from "./blog-posts.js";
import { childEnv, GhPullRequests, run } from "./harness-updates-io.js";

type Exec = typeof run;

export interface BlogGitOptions {
  repo: string;
  baseBranch: string;
  contentDirectory?: string;
  exec?: Exec;
}

/** Opens blog PRs through the gh CLI that is already logged in on the VM. */
export class GhBlogPullRequests implements BlogPublisher {
  private readonly states: GhPullRequests;

  constructor(private readonly options: BlogGitOptions) {
    this.states = new GhPullRequests({
      repo: options.repo,
      baseBranch: options.baseBranch,
      ...(options.exec ? { exec: options.exec } : {}),
    });
  }

  private get exec(): Exec {
    return this.options.exec ?? run;
  }

  pullRequestState(url: string): Promise<"open" | "merged" | "closed"> {
    return this.states.pullRequestState(url);
  }

  openAddPullRequest(input: {
    slug: string;
    mdx: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<{ url: string }> {
    return this.open(input, async (dir, path) => {
      await writeFile(join(dir, path), input.mdx);
    });
  }

  openRemovePullRequest(input: {
    slug: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<{ url: string }> {
    return this.open(input, async (dir, path) => {
      await unlink(join(dir, path));
    });
  }

  private async open(
    input: { slug: string; branch: string; title: string; body: string },
    change: (dir: string, path: string) => Promise<void>,
  ): Promise<{ url: string }> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug))
      throw new Error("블로그 슬러그가 올바르지 않습니다.");
    const { repo, baseBranch } = this.options;
    const path = `${this.options.contentDirectory ?? "apps/blog/content"}/${input.slug}.mdx`;
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
    const work = await mkdtemp(join(tmpdir(), "rapi-blog-pr-"));
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
      await change(dir, path);
      const identity = [
        "-c",
        "user.name=Rapi",
        "-c",
        "user.email=rapi@users.noreply.github.com",
      ];
      await step("git", ["checkout", "-b", input.branch], dir);
      await step("git", ["add", "-A", path], dir);
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

/** Writes the persistent withdrawal list through the same helper the gateway reads with. */
export class FileBlogWithdrawals implements BlogWithdrawals {
  constructor(
    private readonly file: string,
    private readonly root = process.cwd(),
  ) {}

  async record(slug: string): Promise<void> {
    const helper = (await import(
      pathToFileURL(resolve(this.root, "scripts/blog-withdrawals.mjs")).href
    )) as {
      recordWithdrawals(file: string, slugs: string[]): Promise<string[]>;
    };
    await helper.recordWithdrawals(this.file, [slug]);
  }
}

/** Picks weekly guide topics from recent setup/stars community posts. */
export function communityTopics(
  store: Pick<PostgresStore, "learnerCandidatePosts">,
): (since: Date) => Promise<BlogTopic[]> {
  return async (since) =>
    (await store.learnerCandidatePosts(since, ["setup", "stars"])).flatMap(
      (post) => {
        const item = learnerItemFromPost(post);
        return item
          ? [
              {
                key: post.key,
                title: item.title,
                summary: item.summary,
                url: item.url,
              },
            ]
          : [];
      },
    );
}

/** Builds the service only when a blog feature is on and a SUPERADMIN can be asked. */
export function createBlogService(
  config: {
    BLOG_PUBLISH_ENABLED: boolean;
    BLOG_DRAFTS_ENABLED: boolean;
    BLOG_REPO: string;
    BLOG_BASE_BRANCH: string;
    RAPI_BLOG_WITHDRAWALS_FILE?: string | undefined;
    RAPI_PUBLIC_BASE_URL?: string | undefined;
    DISCORD_SUPERADMIN_USER_IDS?: string[] | undefined;
  },
  store: BlogPostsStore,
  postgres: Pick<PostgresStore, "learnerCandidatePosts">,
  delivery: DeliveryAdapter,
  models?: ModelClient,
): BlogService | undefined {
  if (
    !(config.BLOG_PUBLISH_ENABLED || config.BLOG_DRAFTS_ENABLED) ||
    !config.DISCORD_SUPERADMIN_USER_IDS?.length
  )
    return undefined;
  return new BlogService(
    {
      store,
      delivery,
      publisher: new GhBlogPullRequests({
        repo: config.BLOG_REPO,
        baseBranch: config.BLOG_BASE_BRANCH,
      }),
      ...(config.RAPI_BLOG_WITHDRAWALS_FILE
        ? {
            withdrawals: new FileBlogWithdrawals(
              config.RAPI_BLOG_WITHDRAWALS_FILE,
            ),
          }
        : {}),
      ...(models ? { models } : {}),
      recentTopics: communityTopics(postgres),
    },
    {
      superadminIds: config.DISCORD_SUPERADMIN_USER_IDS,
      publishEnabled: config.BLOG_PUBLISH_ENABLED,
      draftsEnabled: config.BLOG_DRAFTS_ENABLED,
      publicBaseUrl: config.RAPI_PUBLIC_BASE_URL,
    },
  );
}
