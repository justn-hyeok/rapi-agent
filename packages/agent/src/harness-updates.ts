import {
  CARD_COLOR,
  contentCard,
  discordEmbed,
  type DeliveryAdapter,
  type DeliveryPayload,
  type DeliveryTarget,
} from "@rapi/core";
import type {
  HarnessUpdateRecord,
  HarnessUpdateState,
  HarnessUpdatesStore,
  NewHarnessUpdate,
} from "@rapi/db";

export interface HarnessPin {
  version: string;
  asset: string;
  sha256: string;
  repo?: string;
}
export type HarnessManifest = Record<string, HarnessPin>;

export interface ReleaseInfo {
  version: string;
  url: string;
  body: string;
  assets: { name: string; url: string }[];
}

export interface ReleaseNotes {
  breaking: string[];
  security: string[];
  renamed: string[];
}

export interface HarnessCheck {
  name: "sha256" | "version" | "settings" | "smoke";
  ok: boolean;
  detail: string;
  durationMs: number;
}

export type Recommendation = "apply" | "hold";

export interface HarnessEvaluation {
  notes: ReleaseNotes;
  checks: HarnessCheck[];
  recommendation: Recommendation;
  reasons: string[];
}

const SECTION_KINDS: [keyof ReleaseNotes, RegExp][] = [
  ["breaking", /breaking|호환성|파괴/i],
  ["security", /security|vulnerab|\bcve\b|보안/i],
  [
    "renamed",
    /renam|deprecat|이름.*변경|설정.*변경|settings?\s+(?:change|migration)/i,
  ],
];
const EMPTY_LINE =
  /^(?:[-*+]\s*)?(?:none|n\/a|na|nothing|no changes?|없음|해당 없음|-+)\.?$/i;

const clean = (line: string): string =>
  line
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

/** Deterministic extraction of breaking, security and renamed-setting notes. */
export function parseReleaseNotes(body: string): ReleaseNotes {
  const notes: ReleaseNotes = { breaking: [], security: [], renamed: [] };
  let active: { kind: keyof ReleaseNotes; level: number } | undefined;
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const heading = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]!.length;
      if (active && level > active.level) continue;
      const title = heading[2]!.replace(/[*_`]/g, "");
      const kind = SECTION_KINDS.find(([, pattern]) => pattern.test(title));
      active = kind ? { kind: kind[0], level } : undefined;
      continue;
    }
    const text = clean(raw);
    if (!text) continue;
    if (active) {
      if (EMPTY_LINE.test(text)) continue;
      notes[active.kind].push(text.slice(0, 300));
      continue;
    }
    const inline = text.match(/^\**breaking(?: change)?s?\**\s*[:：]\s*(.+)$/i);
    if (inline && !EMPTY_LINE.test(inline[1]!))
      notes.breaking.push(inline[1]!.slice(0, 300));
  }
  return notes;
}

export function recommend(
  checks: HarnessCheck[],
  notes: ReleaseNotes,
): { recommendation: Recommendation; reasons: string[] } {
  const reasons: string[] = [];
  for (const check of checks)
    if (!check.ok)
      reasons.push(`${checkLabel(check.name)} 실패: ${check.detail}`);
  if (notes.breaking.length)
    reasons.push(
      `호환성 변경 ${notes.breaking.length}건이 릴리스 노트에 있습니다.`,
    );
  return { recommendation: reasons.length ? "hold" : "apply", reasons };
}

export function evaluationFrom(
  notes: ReleaseNotes,
  checks: HarnessCheck[],
): HarnessEvaluation {
  return { notes, checks, ...recommend(checks, notes) };
}

function checkLabel(name: HarnessCheck["name"]): string {
  return {
    sha256: "체크섬 확인",
    version: "버전 실행",
    settings: "격리 설정 유지",
    smoke: "스모크 프롬프트",
  }[name];
}

const safeRef = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/g, "-");

export function branchName(
  kind: "apply" | "revert",
  update: Pick<HarnessUpdateRecord, "harness" | "fromVersion" | "toVersion">,
): string {
  const harness = safeRef(update.harness);
  return kind === "apply"
    ? `chore/harness-${harness}-${safeRef(update.toVersion)}`
    : `chore/harness-${harness}-revert-${safeRef(update.toVersion)}-to-${safeRef(update.fromVersion)}`;
}

export function pullRequestTitle(
  kind: "apply" | "revert",
  update: Pick<HarnessUpdateRecord, "harness" | "fromVersion" | "toVersion">,
): string {
  return kind === "apply"
    ? `chore(harness): ${update.harness} ${update.fromVersion} → ${update.toVersion}`
    : `chore(harness): ${update.harness} ${update.toVersion} → ${update.fromVersion} 되돌리기`;
}

const asEvaluation = (value: unknown): HarnessEvaluation | null =>
  value && typeof value === "object" && "checks" in value
    ? (value as HarnessEvaluation)
    : null;

function evaluationLines(evaluation: HarnessEvaluation | null): string[] {
  if (!evaluation) return ["- 평가 기록이 없습니다."];
  const lines = evaluation.checks.map(
    (check) =>
      `- ${check.ok ? "통과" : "실패"} · ${checkLabel(check.name)} (${(check.durationMs / 1000).toFixed(1)}초): ${check.detail}`,
  );
  const sections: [string, string[]][] = [
    ["호환성 변경", evaluation.notes.breaking],
    ["보안", evaluation.notes.security],
    ["이름이 바뀐 설정", evaluation.notes.renamed],
  ];
  for (const [label, items] of sections)
    if (items.length)
      lines.push(`- ${label}: ${items.slice(0, 5).join(" / ")}`);
  return lines;
}

const recommendationLabel = (recommendation: Recommendation | null): string =>
  recommendation === "apply" ? "반영 추천" : "보류 추천";

export function pullRequestBody(
  kind: "apply" | "revert",
  update: HarnessUpdateRecord,
): string {
  const evaluation = asEvaluation(update.evaluation);
  const lines =
    kind === "apply"
      ? [
          `## ${update.harness} ${update.fromVersion} → ${update.toVersion}`,
          "",
          `소유자가 DM 버튼으로 반영을 승인해 Rapi가 연 PR입니다. 머지하면 평소처럼 CI와 자동 배포를 거칩니다. 배포 뒤 VM에서 \`scripts/install-${update.harness}.sh\`를 실행해야 새 버전이 설치됩니다.`,
          "",
          `릴리스: ${update.releaseUrl}`,
          `고정 변경: \`ops/harness-versions.json\` (version, sha256)`,
          `새 sha256: \`${update.toSha256 ?? "알 수 없음"}\``,
          "",
          `### 평가 (${recommendationLabel(update.recommendation)})`,
          ...evaluationLines(evaluation),
          ...(evaluation?.reasons.length
            ? ["", "보류 사유:", ...evaluation.reasons.map((r) => `- ${r}`)]
            : []),
        ]
      : [
          `## ${update.harness} ${update.toVersion} → ${update.fromVersion} 되돌리기`,
          "",
          `소유자가 DM 버튼으로 요청해 Rapi가 연 PR입니다. 고정 버전을 이전 값으로 되돌립니다.`,
          `원래 갱신 PR: ${update.prUrl ?? "없음"}`,
          `복원 sha256: \`${update.fromSha256}\``,
        ];
  return lines.join("\n");
}

/** Replaces one harness pin in the manifest text, keeping every other key. */
export function bumpManifest(
  text: string,
  harness: string,
  expectedCurrent: string,
  next: { version: string; sha256: string },
): string {
  const manifest = JSON.parse(text) as HarnessManifest;
  const pin = manifest[harness];
  if (!pin) throw new Error(`${harness} 고정값이 없습니다.`);
  if (pin.version !== expectedCurrent)
    throw new Error(
      `고정 버전이 ${expectedCurrent}가 아니라 ${pin.version}입니다. main이 바뀌었으니 새로 평가해 주세요.`,
    );
  manifest[harness] = { ...pin, version: next.version, sha256: next.sha256 };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const button = (label: string, customId: string, style: number) => ({
  type: 2,
  style,
  label,
  custom_id: customId,
});

export function updateMessage(update: HarnessUpdateRecord): {
  content: string;
  components: unknown[];
} {
  const evaluation = asEvaluation(update.evaluation);
  const content = [
    `**${update.harness} 새 버전: ${update.fromVersion} → ${update.toVersion}**`,
    `릴리스: <${update.releaseUrl}>`,
    ...evaluationLines(evaluation),
    `**${recommendationLabel(update.recommendation)}**`,
    ...(evaluation?.reasons.map((reason) => `• ${reason}`) ?? []),
    "자동으로 바뀌지 않아요. 반영을 누르면 고정 버전을 올리는 PR만 열어요.",
  ].join("\n");
  return {
    content: content.slice(0, 1900),
    components: [
      {
        type: 1,
        components: [
          button("반영", `harness_update_apply:${update.id}`, 3),
          button("건너뛰기", `harness_update_skip:${update.id}`, 2),
          button("나중에", `harness_update_later:${update.id}`, 2),
        ],
      },
    ],
  };
}

export function mergedMessage(update: HarnessUpdateRecord): {
  content: string;
  components: unknown[];
} {
  return {
    content: `${update.harness} ${update.toVersion} 고정 PR이 머지됐어요: <${update.prUrl ?? ""}>\n배포 뒤 VM에서 \`scripts/install-${update.harness}.sh\`로 설치하세요. 문제가 있으면 되돌릴 수 있어요.`,
    components: [
      {
        type: 1,
        components: [
          button("되돌리기", `harness_update_revert:${update.id}`, 4),
        ],
      },
    ],
  };
}

const STATE_MESSAGE: Partial<Record<HarnessUpdateState, string>> = {
  pending_evaluation: "아직 평가 중이에요. 잠시 뒤에 다시 눌러 주세요.",
  applying: "지금 PR을 만드는 중이에요.",
  pr_open: "이미 PR을 열었어요.",
  merged: "이미 반영됐어요.",
  reverting: "지금 되돌리기 PR을 만드는 중이에요.",
  revert_pr_open: "이미 되돌리기 PR을 열었어요.",
  reverted: "이미 되돌렸어요.",
  skipped: "이미 건너뛴 갱신이에요.",
  failed: "처리에 실패한 갱신이에요.",
};

export function pinFor(
  manifest: HarnessManifest,
  harness: string,
): HarnessPin | undefined {
  return manifest[harness];
}

export function releaseFor(
  pin: HarnessPin,
  release: ReleaseInfo,
): NewHarnessUpdate | null {
  return release.version === pin.version || !pin.repo
    ? null
    : {
        harness: "",
        repo: pin.repo,
        fromVersion: pin.version,
        fromSha256: pin.sha256,
        toVersion: release.version,
        asset: pin.asset,
        releaseUrl: release.url,
        releaseBody: release.body,
      };
}

/**
 * The VM cannot judge any release (for example the harness is not installed or
 * logged in), so the result says nothing about the release itself.
 */
export class HarnessEnvironmentError extends Error {}

export type HarnessUpdateStorePort = Pick<
  HarnessUpdatesStore,
  | "detect"
  | "get"
  | "pendingEvaluation"
  | "saveEvaluation"
  | "awaitingNotice"
  | "lastNoticeAt"
  | "markNotified"
  | "dueReminders"
  | "clearReminder"
  | "postpone"
  | "transition"
  | "recordPr"
  | "openPullRequests"
  | "logEvent"
>;

export interface HarnessUpdatePorts {
  store: HarnessUpdateStorePort;
  releases: { latest(repo: string): Promise<ReleaseInfo | null> };
  /** Sandbox checks of the release asset; returns the verified sha256 when known. */
  evaluator: {
    run(
      update: HarnessUpdateRecord,
      release: ReleaseInfo | null,
    ): Promise<{ checks: HarnessCheck[]; sha256: string | null }>;
  };
  git: {
    openPullRequest(input: {
      kind: "apply" | "revert";
      update: HarnessUpdateRecord;
      branch: string;
      title: string;
      body: string;
      next: { version: string; sha256: string };
      expectedCurrent: string;
    }): Promise<{ url: string }>;
    pullRequestState(url: string): Promise<"open" | "merged" | "closed">;
  };
  delivery: DeliveryAdapter;
  readManifest(): Promise<HarnessManifest>;
}

export interface HarnessUpdateOptions {
  superadminIds: string[];
  laterMs?: number;
  detectEveryMs?: number;
  /** Minimum gap between announcements of one harness; default one week. */
  noticeEveryMs?: number;
}

export interface HarnessUpdateIdentity {
  userId: string;
}

const COMPONENT = /^harness_update_(apply|skip|later|revert):([0-9a-f-]{36})$/;
const DAY_MS = 86_400_000;
const DEFAULT_NOTICE_EVERY_MS = 7 * DAY_MS;

export class HarnessUpdateService {
  private lastDetectAt = 0;

  constructor(
    private readonly ports: HarnessUpdatePorts,
    private readonly options: HarnessUpdateOptions,
  ) {}

  static handles(customId: string): boolean {
    return customId.startsWith("harness_update_");
  }

  /** One worker tick: detect (rate limited), evaluate, notify, remind, track PRs. */
  async runDue(now: Date): Promise<void> {
    const failures: string[] = [];
    const attempt = async (step: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        failures.push(
          `${step}: ${error instanceof Error ? error.message : "failed"}`,
        );
      }
    };
    if (
      now.getTime() - this.lastDetectAt >=
      (this.options.detectEveryMs ?? 6 * 3_600_000)
    ) {
      this.lastDetectAt = now.getTime();
      await attempt("detect", async () => {
        await this.detect();
      });
    }
    await attempt("evaluate", () => this.evaluatePending());
    await attempt("notify", () => this.notifyEvaluated(now));
    await attempt("remind", () => this.remind(now));
    await attempt("track", () => this.trackPullRequests());
    if (failures.length) throw new Error(failures.join("; ").slice(0, 300));
  }

  async detect(): Promise<HarnessUpdateRecord[]> {
    const manifest = await this.ports.readManifest();
    const created: HarnessUpdateRecord[] = [];
    for (const [harness, pin] of Object.entries(manifest)) {
      if (!pin.repo) continue;
      const release = await this.ports.releases.latest(pin.repo);
      if (!release) continue;
      const input = releaseFor(pin, release);
      if (!input) continue;
      const record = await this.ports.store.detect({ ...input, harness });
      if (record) created.push(record);
    }
    return created;
  }

  async evaluatePending(): Promise<void> {
    for (const update of await this.ports.store.pendingEvaluation()) {
      if (update.recommendation) continue;
      let evaluation: HarnessEvaluation;
      let sha256: string | null = null;
      try {
        const latest = await this.ports.releases.latest(update.repo);
        const release = latest?.version === update.toVersion ? latest : null;
        const result = await this.ports.evaluator.run(update, release);
        sha256 = result.sha256;
        evaluation = evaluationFrom(
          parseReleaseNotes(update.releaseBody),
          result.checks,
        );
      } catch (error) {
        if (error instanceof HarnessEnvironmentError) {
          await this.ports.store.transition(
            update.id,
            ["pending_evaluation"],
            "skipped",
            undefined,
            "environment_unavailable",
            { reason: error.message.slice(0, 200) },
          );
          continue;
        }
        evaluation = evaluationFrom(parseReleaseNotes(update.releaseBody), [
          {
            name: "sha256",
            ok: false,
            detail:
              error instanceof Error
                ? error.message.slice(0, 200)
                : "평가 실패",
            durationMs: 0,
          },
        ]);
      }
      await this.ports.store.saveEvaluation(
        update.id,
        evaluation,
        evaluation.recommendation,
        sha256,
      );
    }
  }

  private async dm(
    userId: string,
    message: { content: string; components: unknown[]; warn?: boolean },
    key: string,
  ): Promise<boolean> {
    const target: DeliveryTarget = {
      channel: "discord_dm",
      recipientId: userId,
    };
    const payload: DeliveryPayload = {
      subject: "하네스 버전 갱신",
      text: "",
      html: "",
      itemIds: [],
      discord: {
        embeds: [
          discordEmbed(
            contentCard(
              message.content,
              message.warn ? CARD_COLOR.warn : CARD_COLOR.info,
            ),
          ),
        ],
        components: message.components,
      },
    };
    try {
      await this.ports.delivery.send(target, payload, key);
      return true;
    } catch {
      return false;
    }
  }

  private async announce(
    update: HarnessUpdateRecord,
    key: string,
  ): Promise<boolean> {
    let delivered = false;
    for (const adminId of this.options.superadminIds)
      delivered =
        (await this.dm(adminId, updateMessage(update), `${key}:${adminId}`)) ||
        delivered;
    return delivered;
  }

  /**
   * Announces only the newest evaluated release per harness, and at most once
   * per `noticeEveryMs`. Older evaluated releases are dropped as superseded;
   * the newest one waits for the interval and stays replaceable meanwhile.
   */
  async notifyEvaluated(now = new Date()): Promise<void> {
    const newest = new Map<string, HarnessUpdateRecord>();
    for (const update of await this.ports.store.awaitingNotice()) {
      const older = newest.get(update.harness);
      newest.set(update.harness, update);
      if (older)
        await this.ports.store.transition(
          older.id,
          ["pending_evaluation"],
          "skipped",
          undefined,
          "superseded",
          { by: update.toVersion },
        );
    }
    const every = this.options.noticeEveryMs ?? DEFAULT_NOTICE_EVERY_MS;
    for (const update of newest.values()) {
      const last = await this.ports.store.lastNoticeAt(update.harness);
      if (last && now.getTime() - last.getTime() < every) continue;
      if (await this.announce(update, `harness-update:${update.id}`))
        await this.ports.store.markNotified(update.id);
    }
  }

  async remind(now: Date): Promise<void> {
    for (const update of await this.ports.store.dueReminders(now))
      if (
        await this.announce(
          update,
          `harness-update:${update.id}:${now.getTime()}`,
        )
      )
        await this.ports.store.clearReminder(update.id);
  }

  async trackPullRequests(): Promise<void> {
    for (const update of await this.ports.store.openPullRequests()) {
      const reverting = update.state === "revert_pr_open";
      const url = reverting ? update.revertPrUrl : update.prUrl;
      if (!url) continue;
      const state = await this.ports.git.pullRequestState(url);
      if (state === "open") continue;
      if (state === "merged") {
        await this.ports.store.transition(
          update.id,
          [update.state],
          reverting ? "reverted" : "merged",
          undefined,
          reverting ? "revert_merged" : "merged",
        );
        if (reverting) {
          for (const adminId of this.options.superadminIds)
            await this.dm(
              adminId,
              {
                content: `${update.harness} ${update.fromVersion}로 되돌리는 PR이 머지됐어요. 배포 뒤 VM에서 \`scripts/install-${update.harness}.sh\`를 실행하세요.`,
                components: [],
              },
              `harness-update:${update.id}:reverted:${adminId}`,
            );
        } else {
          for (const adminId of this.options.superadminIds)
            await this.dm(
              adminId,
              mergedMessage(update),
              `harness-update:${update.id}:merged:${adminId}`,
            );
        }
      } else {
        await this.ports.store.transition(
          update.id,
          [update.state],
          reverting ? "merged" : "skipped",
          undefined,
          reverting ? "revert_pr_closed" : "pr_closed",
        );
      }
    }
  }

  /** Handles a harness_update_* button; only a SUPERADMIN may press. */
  async handleComponent(
    identity: HarnessUpdateIdentity,
    customId: string,
  ): Promise<string> {
    if (!this.options.superadminIds.includes(identity.userId))
      throw new Error("소유자만 누를 수 있는 버튼입니다.");
    const match = COMPONENT.exec(customId);
    if (!match) throw new Error("알 수 없는 버튼입니다.");
    const [, action, id] = match as unknown as [string, string, string];
    const update = await this.ports.store.get(id);
    if (!update) return "알 수 없는 갱신입니다.";
    const actor = identity.userId;
    const stateNow = async (): Promise<string> =>
      STATE_MESSAGE[(await this.ports.store.get(id))?.state ?? "failed"] ??
      "지금은 처리할 수 없는 상태예요.";

    if (action === "skip") {
      return (await this.ports.store.transition(
        id,
        ["notified"],
        "skipped",
        actor,
        "skipped",
      ))
        ? "이번 버전은 건너뛰었어요."
        : stateNow();
    }
    if (action === "later") {
      const until = new Date(Date.now() + (this.options.laterMs ?? DAY_MS));
      return (await this.ports.store.postpone(id, actor, until))
        ? "24시간 뒤에 다시 알려 드릴게요."
        : stateNow();
    }
    const kind = action === "apply" ? "apply" : "revert";
    const from: HarnessUpdateState = kind === "apply" ? "notified" : "merged";
    const busy: HarnessUpdateState =
      kind === "apply" ? "applying" : "reverting";
    if (
      !(await this.ports.store.transition(
        id,
        [from],
        busy,
        actor,
        `${kind}_requested`,
      ))
    )
      return stateNow();
    const next =
      kind === "apply"
        ? { version: update.toVersion, sha256: update.toSha256 ?? "" }
        : { version: update.fromVersion, sha256: update.fromSha256 };
    try {
      if (!next.sha256)
        throw new Error("검증된 sha256이 없어 PR을 만들 수 없습니다.");
      const pr = await this.ports.git.openPullRequest({
        kind,
        update,
        branch: branchName(kind, update),
        title: pullRequestTitle(kind, update),
        body: pullRequestBody(kind, update),
        next,
        expectedCurrent:
          kind === "apply" ? update.fromVersion : update.toVersion,
      });
      await this.ports.store.recordPr(
        id,
        kind,
        pr.url,
        branchName(kind, update),
      );
      return kind === "apply"
        ? `고정 버전을 올리는 PR을 열었어요: ${pr.url}`
        : `이전 버전으로 되돌리는 PR을 열었어요: ${pr.url}`;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message.slice(0, 300) : "실패";
      await this.ports.store.transition(
        id,
        [busy],
        from,
        undefined,
        `${kind}_failed`,
        { error: reason },
      );
      return `PR을 열지 못했어요: ${reason}\n버튼을 다시 눌러 재시도할 수 있어요.`;
    }
  }
}
