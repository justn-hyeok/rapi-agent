import { buildAppJwt, type RepoWeekData } from "@rapi/core";

export interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  apiBase?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** GitHub App auth and the REST calls Rapi needs; tokens are repo-scoped and short-lived. */
export class GitHubAppClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly base: string;
  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly options: GitHubAppOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.base = options.apiBase ?? "https://api.github.com";
  }

  private async call<T>(
    method: string,
    path: string,
    authorization: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization,
        "user-agent": "rapi-agent",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.arrayBuffer();
      throw new Error(
        `GitHub ${method} ${path.split("?")[0]} -> ${response.status}`,
      );
    }
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }

  appJwt(): string {
    return buildAppJwt(
      this.options.appId,
      this.options.privateKey,
      Math.floor(this.now() / 1000),
    );
  }

  /** The installation covering a repository, with its account login. */
  async installationFor(
    repo: string,
  ): Promise<{ id: number; account: string }> {
    const found = await this.call<{ id: number; account?: { login?: string } }>(
      "GET",
      `/repos/${repo}/installation`,
      `Bearer ${this.appJwt()}`,
    );
    return { id: found.id, account: found.account?.login ?? "" };
  }

  async listInstallations(): Promise<{ id: number; account: string }[]> {
    const rows = await this.call<
      { id: number; account?: { login?: string } }[]
    >("GET", "/app/installations?per_page=100", `Bearer ${this.appJwt()}`);
    return rows.map((row) => ({
      id: row.id,
      account: row.account?.login ?? "",
    }));
  }

  /** Installation token limited to one repository (or all installed ones when omitted). */
  async token(installationId: number, repo?: string): Promise<string> {
    const key = `${installationId}:${repo ?? "*"}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    const issued = await this.call<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      `Bearer ${this.appJwt()}`,
      repo ? { repositories: [repo.split("/")[1]] } : {},
    );
    this.tokens.set(key, {
      token: issued.token,
      expiresAt: Date.parse(issued.expires_at),
    });
    return issued.token;
  }

  private async repoCall<T>(
    installationId: number,
    repo: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.call<T>(
      method,
      path,
      `Bearer ${await this.token(installationId, repo)}`,
      body,
    );
  }

  async react(
    installationId: number,
    repo: string,
    target: { commentId: number | null; number: number; review: boolean },
  ): Promise<void> {
    const path =
      target.commentId === null
        ? `/repos/${repo}/issues/${target.number}/reactions`
        : target.review
          ? `/repos/${repo}/pulls/comments/${target.commentId}/reactions`
          : `/repos/${repo}/issues/comments/${target.commentId}/reactions`;
    await this.repoCall(installationId, repo, "POST", path, {
      content: "eyes",
    });
  }

  async comment(
    installationId: number,
    repo: string,
    number: number,
    body: string,
  ): Promise<void> {
    await this.repoCall(
      installationId,
      repo,
      "POST",
      `/repos/${repo}/issues/${number}/comments`,
      { body: body.slice(0, 60_000) },
    );
  }

  async createPullRequest(
    installationId: number,
    repo: string,
    pull: { head: string; base: string; title: string; body: string },
  ): Promise<string> {
    const created = await this.repoCall<{ html_url: string }>(
      installationId,
      repo,
      "POST",
      `/repos/${repo}/pulls`,
      pull,
    );
    return created.html_url;
  }

  /** Finds the open report issue or opens it; returns its number. */
  async reportIssue(
    installationId: number,
    repo: string,
    title: string,
  ): Promise<number> {
    const open = await this.repoCall<
      { number: number; title: string; pull_request?: unknown }[]
    >(
      installationId,
      repo,
      "GET",
      `/repos/${repo}/issues?state=open&per_page=100`,
    );
    const found = open.find((i) => !i.pull_request && i.title === title);
    if (found) return found.number;
    const created = await this.repoCall<{ number: number }>(
      installationId,
      repo,
      "POST",
      `/repos/${repo}/issues`,
      {
        title,
        body: "Rapi가 매주 월요일에 주간 요약을 이 이슈에 댓글로 남깁니다.",
      },
    );
    return created.number;
  }

  async installationRepos(installationId: number): Promise<string[]> {
    const token = await this.token(installationId);
    const rows = await this.call<{
      repositories: { full_name: string; archived?: boolean }[];
    }>("GET", "/installation/repositories?per_page=100", `Bearer ${token}`);
    return rows.repositories.filter((r) => !r.archived).map((r) => r.full_name);
  }

  /** Deterministic weekly facts for one repository. */
  async repoWeek(
    installationId: number,
    repo: string,
    since: Date,
  ): Promise<RepoWeekData> {
    const get = <T>(path: string): Promise<T> =>
      this.repoCall<T>(installationId, repo, "GET", path);
    const closed = await get<
      { number: number; title: string; merged_at: string | null }[]
    >(
      `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`,
    );
    const issues = await get<
      {
        number: number;
        title: string;
        created_at: string;
        pull_request?: unknown;
      }[]
    >(`/repos/${repo}/issues?state=open&per_page=100`);
    const open = await get<
      {
        number: number;
        title: string;
        updated_at: string;
        draft?: boolean;
        head: { sha: string };
      }[]
    >(`/repos/${repo}/pulls?state=open&per_page=50`);
    const failingChecks: RepoWeekData["failingChecks"] = [];
    for (const pull of open.slice(0, 20)) {
      const runs = await get<{
        check_runs: { name: string; conclusion: string | null }[];
      }>(`/repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=50`);
      const failed = runs.check_runs.find((run) =>
        ["failure", "timed_out", "cancelled"].includes(run.conclusion ?? ""),
      );
      if (failed)
        failingChecks.push({
          pull: pull.number,
          title: pull.title,
          check: failed.name,
        });
    }
    const staleBefore = this.now() - 14 * 86_400_000;
    return {
      repo,
      mergedPulls: closed.flatMap((p) =>
        p.merged_at && Date.parse(p.merged_at) >= since.getTime()
          ? [{ number: p.number, title: p.title, mergedAt: p.merged_at }]
          : [],
      ),
      openIssues: issues
        .filter((i) => !i.pull_request)
        .map((i) => ({
          number: i.number,
          title: i.title,
          createdAt: i.created_at,
        })),
      failingChecks,
      stalePulls: open
        .filter((p) => Date.parse(p.updated_at) < staleBefore)
        .map((p) => ({
          number: p.number,
          title: p.title,
          updatedAt: p.updated_at,
        })),
    };
  }
}
