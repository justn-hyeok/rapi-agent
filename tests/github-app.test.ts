import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  GitHubWeeklyReport,
  GitHubWebhookReceiver,
  createGitHubReport,
} from "@rapi/agent";
import { GitHubAppClient } from "@rapi/adapters";
import { loadEnvironment } from "@rapi/config";
import {
  assertPullRequestBranch,
  buildAppJwt,
  buildRepoReport,
  classifyGitHubEvent,
  githubScope,
  parseGitHubChannel,
  reportBoundary,
  reportDue,
  verifyGitHubSignature,
  type DeliveryAdapter,
  type GitHubRequest,
  type RepoWeekData,
} from "@rapi/core";
import type { GitHubDelivery } from "@rapi/db";
import { openPullRequest, GitHubIntake } from "../apps/chat/src/github.js";
import { ChatOrchestrator } from "../apps/chat/src/orchestrator.js";
import { fakes } from "./helpers/chat-fakes.js";

const secret = "webhook-secret-0123456789";
const policy = { allowedOwners: ["Owner"], ownerLogins: ["justn"] };
const sign = (body: string, key = secret): string =>
  `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

const commentEvent = (overrides: Record<string, unknown> = {}) => ({
  action: "created",
  installation: { id: 77 },
  repository: {
    full_name: "owner/app",
    default_branch: "main",
    owner: { login: "owner" },
  },
  sender: { login: "justn", type: "User" },
  issue: { number: 5 },
  comment: { id: 900, body: "@rapi 로그인 버그 고쳐줘" },
  ...overrides,
});

test("signature: valid, tampered, wrong secret and malformed headers", () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifyGitHubSignature(body, sign('{"a":1}'), secret), true);
  assert.equal(verifyGitHubSignature(body, sign('{"a":2}'), secret), false);
  assert.equal(
    verifyGitHubSignature(body, sign('{"a":1}', "x".repeat(20)), secret),
    false,
  );
  assert.equal(verifyGitHubSignature(body, undefined, secret), false);
  assert.equal(verifyGitHubSignature(body, "sha256=abc", secret), false);
  assert.equal(verifyGitHubSignature(body, sign('{"a":1}'), ""), false);
});

function receiver() {
  const queued: GitHubDelivery[] = [];
  const seen = new Set<string>();
  return {
    queued,
    receiver: new GitHubWebhookReceiver({
      secret,
      policy,
      store: {
        enqueue: async (delivery) => {
          if (seen.has(delivery.deliveryId)) return false;
          seen.add(delivery.deliveryId);
          queued.push(delivery);
          return true;
        },
      },
    }),
  };
}
const post = (
  r: GitHubWebhookReceiver,
  payload: unknown,
  headers: Record<string, string> = {},
  event = "issue_comment",
) => {
  const body = JSON.stringify(payload);
  return r.receive(Buffer.from(body), {
    "x-hub-signature-256": sign(body),
    "x-github-event": event,
    "x-github-delivery": "d-1",
    ...headers,
  });
};

test("webhook: bad signature is 401, a valid delivery queues, a replay does not", async () => {
  const { receiver: r, queued } = receiver();
  const body = Buffer.from(JSON.stringify(commentEvent()));
  assert.equal(
    (
      await r.receive(body, {
        "x-hub-signature-256": sign("other"),
        "x-github-event": "issue_comment",
        "x-github-delivery": "d-1",
      })
    ).status,
    401,
  );
  assert.equal(queued.length, 0);
  assert.equal((await post(r, commentEvent())).status, 202);
  assert.deepEqual((await post(r, commentEvent())).body, { duplicate: true });
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.request.text, "로그인 버그 고쳐줘");
  assert.equal(
    (await post(r, commentEvent(), { "x-github-delivery": "d-2" })).status,
    202,
  );
  assert.equal((await post(r, {}, {}, "ping")).status, 200);
});

test("webhook: only allowlisted installation owners and owner commenters", async () => {
  const { receiver: r, queued } = receiver();
  const foreign = commentEvent({
    repository: {
      full_name: "evil/app",
      default_branch: "main",
      owner: { login: "evil" },
    },
  });
  assert.equal((await post(r, foreign)).status, 403);
  const stranger = commentEvent({ sender: { login: "random", type: "User" } });
  assert.deepEqual(
    (await post(r, stranger, { "x-github-delivery": "d-3" })).body,
    {
      ignored: true,
    },
  );
  const bot = commentEvent({ sender: { login: "rapi[bot]", type: "Bot" } });
  assert.deepEqual((await post(r, bot, { "x-github-delivery": "d-4" })).body, {
    ignored: true,
  });
  const quiet = commentEvent({ comment: { id: 1, body: "no mention here" } });
  assert.deepEqual(
    (await post(r, quiet, { "x-github-delivery": "d-5" })).body,
    {
      ignored: true,
    },
  );
  assert.equal(queued.length, 0);
});

test("classification covers comments, review comments and opened issues", () => {
  const issue = classifyGitHubEvent(
    "issues",
    {
      ...commentEvent({ action: "opened" }),
      issue: { number: 9, body: "버그예요 @rapi 원인 알려줘" },
      comment: undefined,
    },
    policy,
  );
  assert.equal(issue.kind, "request");
  const review = classifyGitHubEvent(
    "pull_request_review_comment",
    {
      ...commentEvent(),
      pull_request: { number: 3 },
      comment: { id: 5, body: "@rapi 멈춰" },
    },
    policy,
  );
  assert.ok(review.kind === "request");
  assert.equal(review.request.text, "멈춰");
  assert.equal(review.request.isPullRequest, true);
  // An email address or a longer handle is not a mention.
  for (const body of ["mail@rapi.dev", "@rapids please", "x/@rapi"])
    assert.equal(
      classifyGitHubEvent(
        "issue_comment",
        commentEvent({ comment: { id: 1, body } }),
        policy,
      ).kind,
      "ignore",
    );
  assert.equal(
    classifyGitHubEvent(
      "issue_comment",
      commentEvent({ action: "edited" }),
      policy,
    ).kind,
    "ignore",
  );
});

test("GitHub threads map to one stable ChatOps scope", () => {
  const scope = githubScope({ repo: "owner/app", number: 5, login: "justn" });
  assert.deepEqual(scope, {
    guild: "github:owner/app",
    channel: "github:owner/app#5",
    owner: "justn",
  });
  assert.deepEqual(parseGitHubChannel(scope.channel), {
    repo: "owner/app",
    number: 5,
  });
  assert.equal(parseGitHubChannel("123456"), undefined);
});

test("app JWT is a verifiable RS256 token with a short lifetime", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwt = buildAppJwt("12345", pem, 1_700_000_000);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as {
    iss: string;
    iat: number;
    exp: number;
  };
  assert.equal(claims.iss, "12345");
  assert.equal(claims.exp - claims.iat <= 600, true);
  assert.equal(
    createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature!, "base64url")),
    true,
  );
});

test("installation tokens are repo-scoped and cached until near expiry", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: { path: string; body: unknown }[] = [];
  let now = 1_700_000_000_000;
  const app = new GitHubAppClient({
    appId: "1",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body as string),
      });
      return new Response(
        JSON.stringify({
          token: `t${calls.length}`,
          expires_at: new Date(now + 3_600_000).toISOString(),
        }),
        { status: 201 },
      );
    }) as typeof fetch,
  });
  assert.equal(await app.token(7, "owner/app"), "t1");
  assert.equal(await app.token(7, "owner/app"), "t1");
  assert.deepEqual(calls[0]!.body, { repositories: ["app"] });
  now += 3_600_000 - 30_000;
  assert.equal(await app.token(7, "owner/app"), "t2");
  assert.equal(calls.length, 2);
});

test("pull requests only use rapi/* branches, never the default", () => {
  assert.doesNotThrow(() => assertPullRequestBranch("rapi/ab12cd34", "main"));
  for (const branch of [
    "main",
    "master",
    "rapi/main/../x",
    "feature/x",
    "rapi/",
  ])
    assert.throws(() => assertPullRequestBranch(branch, "main"));
  assert.throws(() => assertPullRequestBranch("rapi/x", "rapi/x"));
});

test("openPullRequest pushes a rapi/* branch and opens a PR against the default branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-pr-"));
  try {
    const remote = join(root, "remote.git");
    const clone = join(root, "clone");
    execFileSync("git", ["init", "--bare", "-b", "main", remote]);
    execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
    const env = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    await writeFile(join(clone, "a.txt"), "1\n");
    execFileSync("git", ["-C", clone, "checkout", "-b", "main"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", clone, "add", "."]);
    execFileSync("git", ["-C", clone, "commit", "-m", "init"], {
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    execFileSync("git", ["-C", clone, "push", "origin", "main"], {
      stdio: "ignore",
    });
    const pulls: unknown[] = [];
    const app = {
      token: async () => "tok",
      createPullRequest: async (_i: number, _r: string, pull: unknown) => {
        pulls.push(pull);
        return "https://github.com/owner/app/pull/1";
      },
    };
    const run = { id: "abcdef12-0000-4000-8000-000000000000" } as never;
    const linked: string[] = [];
    const input = {
      app,
      store: {
        setPullRequest: async (_id: string, url: string) =>
          void linked.push(url),
      },
      directory: clone,
      repo: "owner/app",
      number: 5,
      installationId: 7,
      defaultBranch: "main",
      run,
      output: "done",
    };
    assert.match(await openPullRequest(input as never), /변경된 파일이 없어/);
    assert.equal(pulls.length, 0);
    await writeFile(join(clone, "a.txt"), "2\n");
    // The test remote needs no auth header; GIT_CONFIG_* is simply ignored.
    process.env.GIT_COMMITTER_NAME = "t";
    const reply = await openPullRequest(input as never);
    assert.match(reply, /pull\/1/);
    assert.deepEqual(linked, ["https://github.com/owner/app/pull/1"]);
    const pull = pulls[0] as { head: string; base: string };
    assert.equal(pull.base, "main");
    assert.equal(pull.head, "rapi/abcdef12");
    const branches = execFileSync("git", [
      "-C",
      remote,
      "branch",
      "--list",
    ]).toString();
    assert.match(branches, /rapi\/abcdef12/);
    const mainLog = execFileSync("git", [
      "-C",
      remote,
      "log",
      "main",
      "--format=%s",
    ]).toString();
    assert.equal(mainLog.trim(), "init");
  } finally {
    delete process.env.GIT_COMMITTER_NAME;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub and Discord requests go through one engine and claim path", async () => {
  const f = fakes();
  const chat = new ChatOrchestrator(f.store, f.executor, f.send);
  const intake = new GitHubIntake({
    store: {
      claimNext: (() => {
        let given = false;
        return async () => {
          if (given) return undefined;
          given = true;
          const request: GitHubRequest = {
            event: "issue_comment",
            repo: "owner/app",
            installationId: 7,
            number: 5,
            isPullRequest: false,
            sourceId: "github:owner/app:comment:900",
            commentId: 900,
            login: "justn",
            text: "오류 고쳐줘",
            defaultBranch: "main",
          };
          return {
            deliveryId: "d-1",
            event: "issue_comment",
            repo: "owner/app",
            request,
          };
        };
      })(),
      finish: async () => undefined,
    },
    app: {
      installationFor: async () => ({ id: 7, account: "owner" }),
      react: async () => undefined,
      comment: async () => undefined,
    },
    chat,
    policy,
  });
  assert.equal(await intake.runOnce(), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.claims[0], [
    {
      guild: "github:owner/app",
      channel: "github:owner/app#5",
      owner: "justn",
    },
    "github:owner/app:comment:900",
    "오류 고쳐줘",
    "execute",
    (f.claims[0] as unknown[])[4],
  ]);
  assert.equal(f.prompts.length, 1);
  assert.equal(
    f.sent.every(([channel]) => channel === "github:owner/app#5"),
    true,
  );
  assert.match(
    f.sent.map(([, text]) => text).join("\n"),
    /작업 .+을 접수했습니다/,
  );
});

test("intake refuses a non-owner commenter or a non-allowed installation", async () => {
  const f = fakes();
  const chat = new ChatOrchestrator(f.store, f.executor, f.send);
  const finished: string[] = [];
  const make = (account: string, login: string) =>
    new GitHubIntake({
      store: {
        claimNext: async () => ({
          deliveryId: "d",
          event: "issue_comment",
          repo: "owner/app",
          request: {
            event: "issue_comment",
            repo: "owner/app",
            installationId: 7,
            number: 1,
            isPullRequest: false,
            sourceId: "s",
            commentId: 1,
            login,
            text: "고쳐줘",
            defaultBranch: "main",
          },
        }),
        finish: async (_id, state) => void finished.push(state),
      },
      app: {
        installationFor: async () => ({ id: 7, account }),
        react: async () => undefined,
        comment: async () => undefined,
      },
      chat,
      policy,
    });
  await make("evil", "justn").runOnce();
  await make("owner", "random").runOnce();
  assert.deepEqual(finished, ["failed", "failed"]);
  assert.equal(f.claims.length, 0);
});

test("report: boundary is Monday 09:00 KST and due only shortly after", () => {
  // 2026-10-26 is a Monday; 09:00 KST = 00:00 UTC.
  assert.equal(
    reportBoundary(new Date("2026-10-26T00:00:00Z")).key,
    "2026-10-26",
  );
  assert.equal(
    reportBoundary(new Date("2026-10-25T23:59:00Z")).key,
    "2026-10-19",
  );
  assert.equal(
    reportBoundary(new Date("2026-10-28T10:00:00Z")).key,
    "2026-10-26",
  );
  assert.equal(reportDue(new Date("2026-10-26T01:00:00Z"))?.key, "2026-10-26");
  assert.equal(reportDue(new Date("2026-10-31T01:00:00Z")), undefined);
});

const week: RepoWeekData = {
  repo: "owner/app",
  mergedPulls: [
    { number: 1, title: "Fix login", mergedAt: "2026-10-20T00:00:00Z" },
  ],
  openIssues: [
    { number: 2, title: "Crash", createdAt: "2026-10-01T00:00:00Z" },
  ],
  failingChecks: [{ pull: 3, title: "WIP", check: "test" }],
  stalePulls: [],
};

test("report builder lists merged PRs, issues, failing checks and stale PRs", () => {
  const text = buildRepoReport(week);
  assert.match(text, /\*\*owner\/app\*\*/);
  assert.match(text, /머지된 PR 1건\n {2}- #1 Fix login/);
  assert.match(text, /열린 이슈 1건/);
  assert.match(text, /#3 WIP · test/);
  assert.match(text, /오래 멈춘 PR 0건[^]*없음/);
});

function reportService(model?: { text: string } | "fail") {
  const sent: string[] = [];
  const claims = new Set<string>();
  const delivery: DeliveryAdapter = {
    send: async (_t, payload) => {
      sent.push(payload.text);
      return {} as never;
    },
  };
  const service = new GitHubWeeklyReport({
    store: {
      claimReport: async (key) => !claims.has(key) && !!claims.add(key),
    },
    app: {
      listInstallations: async () => [
        { id: 7, account: "owner" },
        { id: 8, account: "evil" },
      ],
      installationRepos: async () => ["owner/app"],
      repoWeek: async () => week,
      reportIssue: async () => 1,
      comment: async () => undefined,
    },
    delivery,
    allowedOwners: ["owner"],
    superadminIds: ["111"],
    target: "dm",
    model:
      model === undefined
        ? undefined
        : {
            complete: async (request) => {
              assert.equal(request.feature, "repo_report");
              if (model === "fail") throw new Error("budget");
              return {
                text: model.text,
                model: "m",
                usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 },
              };
            },
          },
  });
  return { service, sent };
}

test("weekly report: once per week, allowed owners only, model summary optional", async () => {
  const plain = reportService();
  const monday = new Date("2026-10-26T01:00:00Z");
  assert.equal(await plain.service.runDue(monday), 1);
  assert.equal(await plain.service.runDue(monday), 0);
  assert.equal(plain.sent.length, 1);
  assert.doesNotMatch(plain.sent[0]!, /evil/);
  assert.doesNotMatch(plain.sent[0]!, /요약:/);
  const summarised = reportService({ text: "이번 주는 조용했습니다." });
  await summarised.service.runDue(monday);
  assert.match(summarised.sent[0]!, /요약: 이번 주는 조용했습니다\./);
  const failing = reportService("fail");
  assert.equal(await failing.service.runDue(monday), 1);
  assert.doesNotMatch(failing.sent[0]!, /요약:/);
  assert.equal(
    await reportService().service.runDue(new Date("2026-10-31T01:00:00Z")),
    0,
  );
});

test("GitHub App is off by default and validated when enabled", () => {
  const base = {
    RAPI_ENV: "test",
    DATABASE_URL: "postgresql://rapi:rapi@localhost:5432/rapi",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_APPLICATION_ID: "1234567890",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    DISCORD_ALLOWED_USER_IDS: "100",
  };
  const off = loadEnvironment(base);
  assert.equal(off.GITHUB_APP_ENABLED, false);
  assert.equal(off.GITHUB_REPORT_TARGET, "dm");
  assert.equal(createGitHubReport(off, {} as never), undefined);
  assert.throws(
    () => loadEnvironment({ ...base, GITHUB_APP_ENABLED: "true" }),
    /GITHUB_APP_ENABLED requires/,
  );
  const on = loadEnvironment({
    ...base,
    GITHUB_APP_ENABLED: "true",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/k.pem",
    GITHUB_APP_WEBHOOK_SECRET: "s".repeat(20),
    GITHUB_APP_ALLOWED_OWNERS: "justn-hyeok",
    GITHUB_APP_OWNER_LOGINS: "justn-hyeok",
    DISCORD_SUPERADMIN_USER_IDS: "100",
  });
  assert.deepEqual(on.GITHUB_APP_OWNER_LOGINS, ["justn-hyeok"]);
});
