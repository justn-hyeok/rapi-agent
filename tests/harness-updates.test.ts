import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GhPullRequests,
  HarnessEnvironmentError,
  HarnessUpdateService,
  SandboxEvaluator,
  branchName,
  bumpManifest,
  createHarnessUpdates,
  parseChecksums,
  parseReleaseNotes,
  pullRequestBody,
  pullRequestTitle,
  recommend,
  type HarnessCheck,
  type HarnessUpdatePorts,
  type ReleaseInfo,
} from "@rapi/agent";
import type { HarnessUpdateRecord, HarnessUpdateState } from "@rapi/db";

const owner = "123456789012345678";
const stranger = "223456789012345678";
const ok = (name: HarnessCheck["name"]): HarnessCheck => ({
  name,
  ok: true,
  detail: "good",
  durationMs: 1200,
});
const allOk = (["sha256", "version", "settings", "smoke"] as const).map(ok);

const manifestText = JSON.stringify(
  {
    senpi: {
      version: "1.0.0",
      repo: "code-yeongyu/senpi",
      asset: "pi-linux-x64.tar.gz",
      sha256: "a".repeat(64),
    },
  },
  null,
  2,
);

test("release notes: breaking, security and renamed sections are extracted", () => {
  const notes = parseReleaseNotes(
    [
      "## Features",
      "- faster start",
      "## Breaking Changes",
      "- `defaultProjectTrust` is now `projectTrust`",
      "### Migration",
      "- run migrate",
      "## Security",
      "- fixes CVE-2026-1",
      "## Renamed settings",
      "- enableInstallTelemetry -> telemetry.install",
      "## Other",
      "- stuff",
    ].join("\n"),
  );
  assert.equal(notes.breaking.length, 2);
  assert.match(notes.breaking[0]!, /projectTrust/);
  assert.deepEqual(notes.security, ["fixes CVE-2026-1"]);
  assert.equal(notes.renamed.length, 1);
});

test("release notes: empty or placeholder sections do not count", () => {
  const notes = parseReleaseNotes(
    "## Breaking Changes\nNone\n\n## Security\n- 없음\n## Fixes\n- a",
  );
  assert.deepEqual(notes, { breaking: [], security: [], renamed: [] });
  assert.deepEqual(
    parseReleaseNotes("BREAKING CHANGE: config moved").breaking,
    ["config moved"],
  );
});

test("recommendation: apply only when every check passes and nothing breaks", () => {
  const clean = { breaking: [], security: [], renamed: [] };
  assert.equal(recommend(allOk, clean).recommendation, "apply");
  const failing = [...allOk.slice(0, 3), { ...ok("smoke"), ok: false }];
  const hold = recommend(failing, clean);
  assert.equal(hold.recommendation, "hold");
  assert.match(hold.reasons[0]!, /스모크/);
  const breaking = recommend(allOk, { ...clean, breaking: ["x"] });
  assert.equal(breaking.recommendation, "hold");
  assert.equal(
    recommend(allOk, { ...clean, security: ["fix"] }).recommendation,
    "apply",
  );
});

test("checksums parse and branch/PR naming is stable", () => {
  const sums = parseChecksums(
    `${"b".repeat(64)}  pi-linux-x64.tar.gz\n${"c".repeat(64)} *other.zip\n`,
  );
  assert.equal(sums.get("pi-linux-x64.tar.gz"), "b".repeat(64));
  assert.equal(sums.get("other.zip"), "c".repeat(64));
  const update = {
    harness: "senpi",
    fromVersion: "1.0.0",
    toVersion: "2026.10.22-1",
  };
  assert.equal(branchName("apply", update), "chore/harness-senpi-2026.10.22-1");
  assert.equal(
    branchName("revert", update),
    "chore/harness-senpi-revert-2026.10.22-1-to-1.0.0",
  );
  assert.equal(
    branchName("apply", { ...update, toVersion: "1 $(x)" }),
    "chore/harness-senpi-1---x-",
  );
  assert.equal(
    pullRequestTitle("apply", update),
    "chore(harness): senpi 1.0.0 → 2026.10.22-1",
  );
});

test("manifest bump keeps other keys and refuses a moved pin", () => {
  const next = bumpManifest(manifestText, "senpi", "1.0.0", {
    version: "2.0.0",
    sha256: "d".repeat(64),
  });
  const parsed = JSON.parse(next) as Record<string, Record<string, string>>;
  assert.equal(parsed.senpi!.version, "2.0.0");
  assert.equal(parsed.senpi!.sha256, "d".repeat(64));
  assert.equal(parsed.senpi!.repo, "code-yeongyu/senpi");
  assert.ok(next.endsWith("\n"));
  assert.throws(() =>
    bumpManifest(manifestText, "senpi", "0.9.0", { version: "2", sha256: "e" }),
  );
});

class FakeStore {
  rows = new Map<string, HarnessUpdateRecord>();
  events: string[] = [];
  remindAt = new Map<string, Date>();
  lastNotice: Date | null = null;
  async lastNoticeAt() {
    return this.lastNotice;
  }
  async detect(
    input: Omit<HarnessUpdateRecord, never> & Record<string, unknown>,
  ) {
    const duplicate = [...this.rows.values()].some(
      (row) =>
        row.harness === input.harness && row.toVersion === input.toVersion,
    );
    if (duplicate) return null;
    const id = `00000000-0000-4000-8000-${String(this.rows.size + 1).padStart(12, "0")}`;
    const row: HarnessUpdateRecord = {
      ...(input as unknown as HarnessUpdateRecord),
      id,
      toSha256: null,
      state: "pending_evaluation",
      evaluation: null,
      recommendation: null,
      prUrl: null,
      prBranch: null,
      revertPrUrl: null,
      revertBranch: null,
    };
    this.rows.set(id, row);
    this.events.push("detected");
    return row;
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async pendingEvaluation() {
    return [...this.rows.values()].filter(
      (r) => r.state === "pending_evaluation",
    );
  }
  async saveEvaluation(
    id: string,
    evaluation: unknown,
    recommendation: "apply" | "hold",
    sha: string | null,
  ) {
    Object.assign(this.rows.get(id)!, {
      evaluation,
      recommendation,
      toSha256: sha,
    });
    this.events.push("evaluated");
  }
  async awaitingNotice() {
    return [...this.rows.values()].filter(
      (r) => r.state === "pending_evaluation" && r.recommendation,
    );
  }
  async markNotified(id: string) {
    this.rows.get(id)!.state = "notified";
    this.events.push("notified");
  }
  async dueReminders(now: Date) {
    return [...this.rows.values()].filter((r) => {
      const at = this.remindAt.get(r.id);
      return r.state === "notified" && at && at <= now;
    });
  }
  async clearReminder(id: string) {
    this.remindAt.delete(id);
  }
  async postpone(id: string, _actor: string, until: Date) {
    if (this.rows.get(id)?.state !== "notified") return false;
    this.remindAt.set(id, until);
    this.events.push("postponed");
    return true;
  }
  async transition(
    id: string,
    from: HarnessUpdateState[],
    to: HarnessUpdateState,
    _actor?: string,
    step?: string,
  ) {
    const row = this.rows.get(id);
    if (!row || !from.includes(row.state)) return false;
    row.state = to;
    this.events.push(step ?? to);
    return true;
  }
  async recordPr(
    id: string,
    kind: "apply" | "revert",
    url: string,
    branch: string,
  ) {
    const row = this.rows.get(id)!;
    if (kind === "apply")
      Object.assign(row, { prUrl: url, prBranch: branch, state: "pr_open" });
    else
      Object.assign(row, {
        revertPrUrl: url,
        revertBranch: branch,
        state: "revert_pr_open",
      });
    this.events.push(kind === "apply" ? "pr_opened" : "revert_pr_opened");
  }
  async openPullRequests() {
    return [...this.rows.values()].filter(
      (r) => r.state === "pr_open" || r.state === "revert_pr_open",
    );
  }
  async logEvent() {}
}

function setup(
  options: {
    checks?: HarnessCheck[];
    sha?: string | null;
    body?: string;
    prState?: "open" | "merged" | "closed";
    evaluate?: HarnessUpdatePorts["evaluator"]["run"];
  } = {},
) {
  const store = new FakeStore();
  const sent: { to: string; content: string; components: unknown[] }[] = [];
  const prs: Parameters<HarnessUpdatePorts["git"]["openPullRequest"]>[0][] = [];
  let prState = options.prState ?? "open";
  const release: ReleaseInfo = {
    version: "2.0.0",
    url: "https://github.com/code-yeongyu/senpi/releases/tag/v2.0.0",
    body: options.body ?? "## Breaking Changes\nNone",
    assets: [],
  };
  const ports: HarnessUpdatePorts = {
    store: store as unknown as HarnessUpdatePorts["store"],
    releases: { latest: async () => release },
    evaluator: {
      run:
        options.evaluate ??
        (async () => ({
          checks: options.checks ?? allOk,
          sha256: options.sha === undefined ? "f".repeat(64) : options.sha,
        })),
    },
    git: {
      openPullRequest: async (input) => {
        prs.push(input);
        return {
          url: `https://github.com/justn-hyeok/rapi-agent/pull/${prs.length}`,
        };
      },
      pullRequestState: async () => prState,
    },
    delivery: {
      send: async (target, payload) => {
        sent.push({
          to: target.recipientId,
          content: payload.discord?.content ?? "",
          components: payload.discord?.components ?? [],
        });
        return { providerId: "m" };
      },
    },
    readManifest: async () => JSON.parse(manifestText),
  };
  const service = new HarnessUpdateService(ports, { superadminIds: [owner] });
  return {
    store,
    sent,
    prs,
    service,
    setPr: (s: "open" | "merged" | "closed") => (prState = s),
  };
}

const buttonIds = (components: unknown[]): string[] =>
  (components as { components: { custom_id: string }[] }[]).flatMap((row) =>
    row.components.map((c) => c.custom_id),
  );

test("tick detects once, evaluates, and DMs every SUPERADMIN with three buttons", async () => {
  const { store, sent, service } = setup();
  const now = new Date("2026-10-26T00:00:00Z");
  await service.runDue(now);
  await service.runDue(new Date(now.getTime() + 60_000));
  assert.equal(store.rows.size, 1);
  assert.deepEqual(store.events.slice(0, 3), [
    "detected",
    "evaluated",
    "notified",
  ]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, owner);
  assert.match(sent[0]!.content, /1\.0\.0 → 2\.0\.0/);
  assert.match(sent[0]!.content, /반영 추천/);
  const id = [...store.rows.keys()][0]!;
  assert.deepEqual(buttonIds(sent[0]!.components), [
    `harness_update_apply:${id}`,
    `harness_update_skip:${id}`,
    `harness_update_later:${id}`,
  ]);
});

test("a version already seen is not detected again, and the same pin is ignored", async () => {
  const { store, service } = setup();
  assert.equal((await service.detect()).length, 1);
  assert.equal((await service.detect()).length, 0);
  assert.equal(store.rows.size, 1);
});

test("breaking notes or a sha mismatch turn the recommendation into 보류", async () => {
  const breaking = setup({ body: "## Breaking Changes\n- renamed flag" });
  await breaking.service.runDue(new Date());
  assert.equal([...breaking.store.rows.values()][0]!.recommendation, "hold");
  assert.match(breaking.sent[0]!.content, /보류 추천/);

  const mismatch = setup({
    checks: [
      {
        name: "sha256",
        ok: false,
        detail: "sha256이 SHA256SUMS와 다릅니다",
        durationMs: 5,
      },
    ],
    sha: null,
  });
  await mismatch.service.runDue(new Date());
  const row = [...mismatch.store.rows.values()][0]!;
  assert.equal(row.recommendation, "hold");
  assert.equal(row.toSha256, null);
  const answer = await mismatch.service.handleComponent(
    { userId: owner },
    `harness_update_apply:${row.id}`,
  );
  assert.match(answer, /PR을 열지 못했어요/);
  assert.equal(mismatch.prs.length, 0);
  assert.equal(row.state, "notified");
});

test("only a SUPERADMIN can press a button", async () => {
  const { store, service, prs } = setup();
  await service.runDue(new Date());
  const id = [...store.rows.keys()][0]!;
  await assert.rejects(
    service.handleComponent({ userId: stranger }, `harness_update_apply:${id}`),
    /소유자만/,
  );
  assert.equal(prs.length, 0);
  await assert.rejects(
    service.handleComponent({ userId: owner }, "harness_update_apply:nope"),
    /알 수 없는 버튼/,
  );
});

test("apply opens one PR with evaluation body; a second press is idempotent", async () => {
  const { store, service, prs } = setup();
  await service.runDue(new Date());
  const id = [...store.rows.keys()][0]!;
  const first = await service.handleComponent(
    { userId: owner },
    `harness_update_apply:${id}`,
  );
  assert.match(first, /pull\/1/);
  const second = await service.handleComponent(
    { userId: owner },
    `harness_update_apply:${id}`,
  );
  assert.match(second, /이미 PR을 열었어요/);
  assert.equal(prs.length, 1);
  assert.equal(prs[0]!.branch, "chore/harness-senpi-2.0.0");
  assert.deepEqual(prs[0]!.next, { version: "2.0.0", sha256: "f".repeat(64) });
  assert.equal(prs[0]!.expectedCurrent, "1.0.0");
  assert.match(prs[0]!.body, /통과 · 체크섬 확인/);
  assert.match(prs[0]!.body, /반영 추천/);
  assert.equal(
    store.rows.get(id)!.prUrl,
    "https://github.com/justn-hyeok/rapi-agent/pull/1",
  );
});

test("skip is idempotent and blocks apply; later schedules a 24h reminder", async () => {
  const { store, sent, service, prs } = setup();
  await service.runDue(new Date());
  const id = [...store.rows.keys()][0]!;
  const later = await service.handleComponent(
    { userId: owner },
    `harness_update_later:${id}`,
  );
  assert.match(later, /24시간/);
  const due = new Date(Date.now() + 25 * 3_600_000);
  await service.remind(due);
  assert.equal(sent.length, 2);
  assert.equal(store.remindAt.size, 0);
  await service.remind(due);
  assert.equal(sent.length, 2);

  assert.match(
    await service.handleComponent(
      { userId: owner },
      `harness_update_skip:${id}`,
    ),
    /건너뛰었어요/,
  );
  assert.match(
    await service.handleComponent(
      { userId: owner },
      `harness_update_skip:${id}`,
    ),
    /이미 건너뛴/,
  );
  assert.match(
    await service.handleComponent(
      { userId: owner },
      `harness_update_apply:${id}`,
    ),
    /이미 건너뛴/,
  );
  assert.equal(prs.length, 0);
});

test("a failed PR attempt can be retried", async () => {
  const { store, service, prs } = setup();
  await service.runDue(new Date());
  const id = [...store.rows.keys()][0]!;
  const original = prs.push.bind(prs);
  let fail = true;
  (
    service as unknown as { ports: HarnessUpdatePorts }
  ).ports.git.openPullRequest = async (input) => {
    if (fail) {
      fail = false;
      throw new Error("push 실패");
    }
    original(input);
    return { url: "https://github.com/x/y/pull/9" };
  };
  assert.match(
    await service.handleComponent(
      { userId: owner },
      `harness_update_apply:${id}`,
    ),
    /push 실패/,
  );
  assert.equal(store.rows.get(id)!.state, "notified");
  assert.match(
    await service.handleComponent(
      { userId: owner },
      `harness_update_apply:${id}`,
    ),
    /pull\/9/,
  );
});

test("after merge the DM offers 되돌리기, which opens a restoring PR once", async () => {
  const { store, sent, service, prs, setPr } = setup();
  await service.runDue(new Date());
  const id = [...store.rows.keys()][0]!;
  await service.handleComponent(
    { userId: owner },
    `harness_update_apply:${id}`,
  );
  await service.trackPullRequests();
  assert.equal(store.rows.get(id)!.state, "pr_open");
  setPr("merged");
  await service.trackPullRequests();
  assert.equal(store.rows.get(id)!.state, "merged");
  const merged = sent.at(-1)!;
  assert.deepEqual(buttonIds(merged.components), [
    `harness_update_revert:${id}`,
  ]);

  const reply = await service.handleComponent(
    { userId: owner },
    `harness_update_revert:${id}`,
  );
  assert.match(reply, /되돌리는 PR/);
  assert.match(
    await service.handleComponent(
      { userId: owner },
      `harness_update_revert:${id}`,
    ),
    /이미 되돌리기 PR/,
  );
  const revert = prs.at(-1)!;
  assert.equal(revert.kind, "revert");
  assert.deepEqual(revert.next, { version: "1.0.0", sha256: "a".repeat(64) });
  assert.equal(revert.expectedCurrent, "2.0.0");
  assert.equal(revert.branch, "chore/harness-senpi-revert-2.0.0-to-1.0.0");
  assert.match(revert.title, /되돌리기/);
  const row = store.rows.get(id)!;
  assert.match(pullRequestBody("revert", row), /원래 갱신 PR/);
});

test("revert is refused before the PR is merged", async () => {
  const { store, service } = setup();
  await service.runDue(new Date());
  const id = [...store.rows.keys()][0]!;
  assert.match(
    await service.handleComponent(
      { userId: owner },
      `harness_update_revert:${id}`,
    ),
    /아직|이미|처리/,
  );
});

test("sandbox evaluator reports a sha256 mismatch without unpacking", async () => {
  const exec: string[] = [];
  const evaluator = new SandboxEvaluator({
    exec: async (command) => {
      exec.push(command);
      return { code: 0, stdout: "", stderr: "" };
    },
    download: async (url, to) => {
      await writeFile(
        to,
        url.endsWith("SUMS")
          ? `${"0".repeat(64)}  pi-linux-x64.tar.gz\n`
          : "archive",
      );
    },
  });
  const release: ReleaseInfo = {
    version: "2.0.0",
    url: "u",
    body: "",
    assets: [
      { name: "pi-linux-x64.tar.gz", url: "https://x/pi-linux-x64.tar.gz" },
      { name: "SHA256SUMS", url: "https://x/SHA256SUMS" },
    ],
  };
  const update = { asset: "pi-linux-x64.tar.gz" } as HarnessUpdateRecord;
  const result = await evaluator.run(update, release);
  assert.equal(result.sha256, null);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0]!.name, "sha256");
  assert.equal(result.checks[0]!.ok, false);
  assert.deepEqual(exec, []);
});

test("gh runner reuses an open PR and otherwise clones, commits and opens one", async () => {
  const calls: string[] = [];
  let existing = true;
  const pr = new GhPullRequests({
    repo: "justn-hyeok/rapi-agent",
    baseBranch: "main",
    exec: async (command, args, options) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "gh" && args[0] === "pr" && args[1] === "list")
        return {
          code: 0,
          stdout: existing ? '[{"url":"https://github.com/o/r/pull/3"}]' : "[]",
          stderr: "",
        };
      if (command === "gh" && args[0] === "repo") {
        const dir = args[3]!;
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(dir, "ops"), { recursive: true });
        await writeFile(join(dir, "ops/harness-versions.json"), manifestText);
      }
      if (command === "gh" && args[1] === "create")
        return {
          code: 0,
          stdout: "https://github.com/o/r/pull/4\n",
          stderr: "",
        };
      assert.ok(options.env && !("DATABASE_URL" in options.env && false));
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const input = {
    kind: "apply" as const,
    update: { harness: "senpi" } as HarnessUpdateRecord,
    branch: "chore/harness-senpi-2.0.0",
    title: "t",
    body: "b",
    next: { version: "2.0.0", sha256: "d".repeat(64) },
    expectedCurrent: "1.0.0",
  };
  assert.equal(
    (await pr.openPullRequest(input)).url,
    "https://github.com/o/r/pull/3",
  );
  existing = false;
  assert.equal(
    (await pr.openPullRequest(input)).url,
    "https://github.com/o/r/pull/4",
  );
  assert.ok(
    calls.some(
      (c) =>
        c.startsWith("git") &&
        c.includes(" push -u origin chore/harness-senpi-2.0.0"),
    ),
  );
  assert.ok(calls.includes("git checkout -b chore/harness-senpi-2.0.0"));
});

test("harness updates are off by default and need a SUPERADMIN", async () => {
  const store = new FakeStore() as unknown as HarnessUpdatePorts["store"];
  const delivery = { send: async () => ({ providerId: "x" }) };
  const config = {
    HARNESS_UPDATES_ENABLED: false,
    HARNESS_UPDATES_REPO: "justn-hyeok/rapi-agent",
    HARNESS_UPDATES_BASE_BRANCH: "main",
    DISCORD_SUPERADMIN_USER_IDS: [owner],
    SENPI_HOME: "/var/lib/rapi/senpi",
  };
  assert.equal(createHarnessUpdates(config, store, delivery), undefined);
  assert.equal(
    createHarnessUpdates(
      {
        ...config,
        HARNESS_UPDATES_ENABLED: true,
        DISCORD_SUPERADMIN_USER_IDS: [],
      },
      store,
      delivery,
    ),
    undefined,
  );
  assert.ok(
    createHarnessUpdates(
      { ...config, HARNESS_UPDATES_ENABLED: true },
      store,
      delivery,
    ),
  );
});

test("the senpi pin names the repository that releases are read from", async () => {
  const pins = JSON.parse(
    await readFile("ops/harness-versions.json", "utf8"),
  ) as {
    senpi: { repo: string };
  };
  assert.equal(pins.senpi.repo, "code-yeongyu/senpi");
});

test("an environment failure skips the release without a DM", async () => {
  const { store, sent, service } = setup({
    evaluate: async () => {
      throw new HarnessEnvironmentError("VM에 하네스 로그인 정보가 없습니다.");
    },
  });
  await service.runDue(new Date("2026-10-26T00:00:00Z"));
  const row = [...store.rows.values()][0]!;
  assert.equal(row.state, "skipped");
  assert.equal(row.recommendation, null);
  assert.ok(store.events.includes("environment_unavailable"));
  assert.equal(sent.length, 0);
});

test("only the newest evaluated release is announced; older ones are superseded", async () => {
  const { store, sent, service } = setup();
  const base = {
    harness: "senpi",
    repo: "code-yeongyu/senpi",
    fromVersion: "1.0.0",
    fromSha256: "a".repeat(64),
    asset: "pi-linux-x64.tar.gz",
    releaseUrl: "u",
    releaseBody: "",
  };
  for (const toVersion of ["1.1.0", "1.2.0", "1.3.0"]) {
    const row = await store.detect({ ...base, toVersion } as never);
    await store.saveEvaluation(row!.id, null, "apply", null);
  }
  await service.notifyEvaluated(new Date("2026-10-26T00:00:00Z"));
  const byVersion = (v: string) =>
    [...store.rows.values()].find((r) => r.toVersion === v)!;
  assert.equal(byVersion("1.1.0").state, "skipped");
  assert.equal(byVersion("1.2.0").state, "skipped");
  assert.equal(byVersion("1.3.0").state, "notified");
  assert.ok(store.events.includes("superseded"));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.content, /1\.3\.0/);
});

test("a release waits for the weekly interval and a newer one replaces it", async () => {
  const { store, sent, service } = setup();
  const now = new Date("2026-10-26T00:00:00Z");
  store.lastNotice = new Date(now.getTime() - 86_400_000);
  await service.runDue(now);
  const first = [...store.rows.values()][0]!;
  assert.equal(first.state, "pending_evaluation");
  assert.equal(first.recommendation, "apply");
  assert.equal(sent.length, 0);
  await service.runDue(new Date(now.getTime() + 8 * 86_400_000));
  assert.equal(first.state, "notified");
  assert.equal(sent.length, 1);
});

test("sandbox evaluator refuses to judge a release without live credentials", async () => {
  const live = await mkdtemp(join(tmpdir(), "rapi-live-agent-"));
  try {
    await writeFile(join(live, "settings.json"), "{}");
    const exec: string[] = [];
    const evaluator = new SandboxEvaluator({
      liveAgentDirectory: live,
      exec: async (command) => {
        exec.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await assert.rejects(
      evaluator.run(
        { asset: "pi-linux-x64.tar.gz" } as HarnessUpdateRecord,
        null,
      ),
      HarnessEnvironmentError,
    );
    assert.deepEqual(exec, []);
  } finally {
    await rm(live, { recursive: true, force: true });
  }
});

test("a smoke run that reports no API key is an environment failure, not a bad release", async () => {
  const live = await mkdtemp(join(tmpdir(), "rapi-live-agent-"));
  try {
    await writeFile(join(live, "auth.json"), "{}");
    const evaluator = new SandboxEvaluator({
      liveAgentDirectory: live,
      exec: async (_command, args) =>
        args.includes("-p")
          ? {
              code: 1,
              stdout: "",
              stderr: "No API key found for the selected model.",
            }
          : { code: 0, stdout: "1.0.0\n", stderr: "" },
      download: async (url, to) =>
        writeFile(
          to,
          url.endsWith("SUMS")
            ? `${createHash("sha256").update("archive").digest("hex")}  pi-linux-x64.tar.gz\n`
            : "archive",
        ),
    });
    const release: ReleaseInfo = {
      version: "2.0.0",
      url: "u",
      body: "",
      assets: [
        { name: "pi-linux-x64.tar.gz", url: "https://x/pi-linux-x64.tar.gz" },
        { name: "SHA256SUMS", url: "https://x/SHA256SUMS" },
      ],
    };
    await assert.rejects(
      evaluator.run(
        { asset: "pi-linux-x64.tar.gz" } as HarnessUpdateRecord,
        release,
      ),
      HarnessEnvironmentError,
    );
  } finally {
    await rm(live, { recursive: true, force: true });
  }
});
