import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/** Verifies `X-Hub-Signature-256` over the raw body in constant time. */
export function verifyGitHubSignature(
  body: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/i.test(header))
    return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(body).digest("hex"),
  );
  const received = Buffer.from(header.slice("sha256=".length).toLowerCase());
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/** RS256 JWT that authenticates as the GitHub App itself (max 10 minutes). */
export function buildAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat is backdated to tolerate clock drift, as GitHub recommends.
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKeyPem);
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface GitHubAccessPolicy {
  /** Accounts whose installations are accepted (lower-cased on compare). */
  allowedOwners: readonly string[];
  /** Logins that may call @rapi. */
  ownerLogins: readonly string[];
}

/** What the chat process needs to run a request; stored in the delivery inbox. */
export interface GitHubRequest {
  event: "issue_comment" | "pull_request_review_comment" | "issues";
  repo: string;
  installationId: number;
  number: number;
  isPullRequest: boolean;
  /** Unique per comment/issue; becomes the ChatOps message id. */
  sourceId: string;
  commentId: number | null;
  login: string;
  /** Text after the first `@rapi`. */
  text: string;
  defaultBranch: string;
}

export type GitHubClassification =
  | { kind: "ignore"; reason: string }
  | { kind: "forbidden_owner"; reason: string }
  | { kind: "stranger"; request: GitHubRequest }
  | { kind: "request"; request: GitHubRequest };

const MENTION = /(^|[^\w@/.-])@rapi(?![\w-])/i;

export function extractMention(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  const match = MENTION.exec(body);
  if (!match) return undefined;
  return body
    .slice(match.index + match[0].length)
    .trim()
    .slice(0, 4000);
}

const inList = (list: readonly string[], value: string): boolean =>
  list.some((item) => item.toLowerCase() === value.toLowerCase());

type Json = Record<string, unknown>;
const obj = (value: unknown): Json =>
  value && typeof value === "object" ? (value as Json) : {};
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

/** Account that owns the installation; event payloads may only carry the repository owner. */
export function installationAccount(payload: unknown): string | undefined {
  const body = obj(payload);
  return (
    str(obj(obj(body.installation).account).login) ??
    str(obj(obj(body.repository).owner).login)
  );
}

export function classifyGitHubEvent(
  event: string,
  payload: unknown,
  policy: GitHubAccessPolicy,
): GitHubClassification {
  const body = obj(payload);
  const account = installationAccount(body);
  if (!account || !inList(policy.allowedOwners, account))
    return {
      kind: "forbidden_owner",
      reason: "installation owner not allowed",
    };
  const action = str(body.action);
  const repository = obj(body.repository);
  const repo = str(repository.full_name);
  const installationId = num(obj(body.installation).id);
  const login = str(obj(body.sender).login);
  if (!repo || !installationId || !login)
    return { kind: "ignore", reason: "incomplete payload" };
  if (obj(body.sender).type === "Bot")
    return { kind: "ignore", reason: "bot sender" };
  const defaultBranch = str(repository.default_branch) ?? "main";
  let number: number | undefined;
  let text: string | undefined;
  let sourceId: string;
  let commentId: number | null = null;
  let isPullRequest = false;
  if (event === "issue_comment" && action === "created") {
    const issue = obj(body.issue);
    const comment = obj(body.comment);
    number = num(issue.number);
    commentId = num(comment.id) ?? null;
    isPullRequest = "pull_request" in issue;
    text = extractMention(comment.body);
    sourceId = `github:${repo}:comment:${commentId}`;
  } else if (event === "pull_request_review_comment" && action === "created") {
    const pull = obj(body.pull_request);
    const comment = obj(body.comment);
    number = num(pull.number);
    commentId = num(comment.id) ?? null;
    isPullRequest = true;
    text = extractMention(comment.body);
    sourceId = `github:${repo}:review:${commentId}`;
  } else if (event === "issues" && action === "opened") {
    const issue = obj(body.issue);
    number = num(issue.number);
    text = extractMention(issue.body);
    sourceId = `github:${repo}:issue:${number}`;
  } else return { kind: "ignore", reason: "event not handled" };
  if (
    !number ||
    text === undefined ||
    (commentId === null && event !== "issues")
  )
    return { kind: "ignore", reason: "no mention" };
  const request: GitHubRequest = {
    event: event as GitHubRequest["event"],
    repo,
    installationId,
    number,
    isPullRequest,
    sourceId,
    commentId,
    login,
    text,
    defaultBranch,
  };
  return inList(policy.ownerLogins, login)
    ? { kind: "request", request }
    : { kind: "stranger", request };
}

/** ChatOps scope for a GitHub thread: one queue/cancel key per issue or PR. */
export function githubScope(
  request: Pick<GitHubRequest, "repo" | "number" | "login">,
): {
  guild: string;
  channel: string;
  owner: string;
} {
  return {
    guild: `github:${request.repo}`,
    channel: `github:${request.repo}#${request.number}`,
    owner: request.login,
  };
}

export function parseGitHubChannel(
  channel: string,
): { repo: string; number: number } | undefined {
  const match = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(channel);
  return match ? { repo: match[1]!, number: Number(match[2]) } : undefined;
}

/** The only branches Rapi may push: never the default or a protected name. */
export function assertPullRequestBranch(
  branch: string,
  defaultBranch: string,
): void {
  if (
    branch === defaultBranch ||
    !/^rapi\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(branch) ||
    branch.includes("..")
  )
    throw new Error(`Refusing to push to ${branch}: only rapi/* PR branches`);
}

export interface RepoWeekData {
  repo: string;
  mergedPulls: { number: number; title: string; mergedAt: string }[];
  openIssues: { number: number; title: string; createdAt: string }[];
  failingChecks: { pull: number; title: string; check: string }[];
  stalePulls: { number: number; title: string; updatedAt: string }[];
}

const KST_OFFSET_MS = 9 * 3_600_000;

/** Latest Monday 09:00 Asia/Seoul at or before `now` (KST has no DST). */
export function reportBoundary(now: Date): { key: string; start: Date } {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const sinceMonday = (kst.getUTCDay() + 6) % 7;
  const monday = Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate() - sinceMonday,
    9,
  );
  const boundary = monday > kst.getTime() ? monday - 7 * 86_400_000 : monday;
  return {
    key: new Date(boundary).toISOString().slice(0, 10),
    start: new Date(boundary - KST_OFFSET_MS),
  };
}

/** A report is sent within three days after the boundary, once per key. */
export function reportDue(now: Date): { key: string; start: Date } | undefined {
  const boundary = reportBoundary(now);
  return now.getTime() - boundary.start.getTime() <= 3 * 86_400_000
    ? boundary
    : undefined;
}

const clip = (text: string, max = 80): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function buildRepoReport(data: RepoWeekData): string {
  const list = <T>(
    items: T[],
    line: (item: T) => string,
    limit = 8,
  ): string[] =>
    items.length
      ? [
          ...items.slice(0, limit).map((item) => `  - ${line(item)}`),
          ...(items.length > limit
            ? [`  - …외 ${items.length - limit}건`]
            : []),
        ]
      : ["  - 없음"];
  return [
    `**${data.repo}**`,
    `- 이번 주 머지된 PR ${data.mergedPulls.length}건`,
    ...list(data.mergedPulls, (p) => `#${p.number} ${clip(p.title)}`),
    `- 열린 이슈 ${data.openIssues.length}건`,
    ...list(data.openIssues, (i) => `#${i.number} ${clip(i.title)}`),
    `- 검사 실패 PR ${data.failingChecks.length}건`,
    ...list(
      data.failingChecks,
      (c) => `#${c.pull} ${clip(c.title, 50)} · ${clip(c.check, 30)}`,
    ),
    `- 오래 멈춘 PR ${data.stalePulls.length}건 (14일 이상 변화 없음)`,
    ...list(
      data.stalePulls,
      (p) => `#${p.number} ${clip(p.title)} · ${p.updatedAt.slice(0, 10)}`,
    ),
  ].join("\n");
}
