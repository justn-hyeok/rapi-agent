import {
  LEARNER_SECTIONS,
  isLearnerCadence,
  learnerIssueBoundary,
  learnerItemFromPost,
  learnerLinkKey,
  learnerReportBoundary,
  learnerVerdict,
  safeLearnerUrl,
  selectLearnerItems,
  signLearnerLink,
  verifyLearnerLink,
  type DeliveryAdapter,
  type LearnerCadence,
  type LearnerItemDraft,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";

type LearnerStore = Pick<
  PostgresStore,
  | "learnerSubscribe"
  | "learnerSetCadence"
  | "learnerOptOut"
  | "learnerSetEmailInterest"
  | "learnerActiveSubscribers"
  | "learnerMarkEmailAsked"
  | "learnerCandidatePosts"
  | "learnerLastWindowEnd"
  | "learnerCreateIssue"
  | "learnerIssueExists"
  | "learnerIssue"
  | "learnerIssuesAwaitingPreview"
  | "learnerMarkPreviewSent"
  | "learnerDecideIssue"
  | "learnerFinishIssue"
  | "learnerIssueState"
  | "learnerRecordDelivery"
  | "learnerDeliveryCounts"
  | "learnerItemUrl"
  | "learnerRecordClick"
  | "learnerReportClaim"
  | "learnerReportData"
>;

export interface LearnerExperimentOptions {
  superadminIds: string[];
  /** Secret the click-link key is derived from. */
  linkSecret: string;
  /** Public origin whose gateway forwards `/r/<token>` to the bot. */
  baseUrl: string;
  pauseMs?: number;
  /** Called once an approved issue has been sent (blog archive); failures are ignored. */
  onIssueSent?: (issue: {
    id: string;
    cadence: LearnerCadence;
    periodKey: string;
    items: Array<{
      section: "core" | "tools";
      title: string;
      summary: string;
      url: string;
    }>;
  }) => Promise<void>;
}

export interface LearnerIdentity {
  userId: string;
  guildId?: string;
}

export interface LearnerReply {
  content: string;
  components?: unknown[];
}

const FEEDS = ["free-tokens", "setup", "stars"];
const FREE_MODELS_URL = "https://openrouter.ai/models?max_price=0";
const CADENCE_LABEL: Record<LearnerCadence, string> = {
  daily: "매일",
  weekly: "매주",
};
const PERIOD_MS: Record<LearnerCadence, number> = {
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
};
// DM content is limited to 2000 characters; stay below with headroom.
const CONTENT_BUDGET = 1800;

const button = (label: string, customId: string, style = 2) => ({
  type: 2,
  style,
  label,
  custom_id: customId,
});
const row = (...components: unknown[]) => ({ type: 1, components });

export function learnerGuideMessage(): {
  content: string;
  components: unknown[];
} {
  return {
    content: [
      "**라피 학습자 소식**",
      "AI 도구를 막 시작한 분을 위해 무료 토큰, 설정법, 쓸 만한 도구를 골라 DM으로 보내 드려요.",
      "받는 빈도는 직접 고를 수 있고, 언제든 그만 받을 수 있어요.",
    ].join("\n"),
    components: [row(button("학습자 소식 DM으로 받기", "learner_optin", 1))],
  };
}

export class LearnerExperiment {
  private readonly key: Buffer;

  constructor(
    private readonly store: LearnerStore,
    private readonly delivery: DeliveryAdapter,
    private readonly options: LearnerExperimentOptions,
  ) {
    this.key = learnerLinkKey(options.linkSecret);
  }

  private cadenceChoice(content: string): LearnerReply {
    return {
      content,
      components: [
        row(
          button("매일", "learner_cadence:daily", 1),
          button("매주", "learner_cadence:weekly", 1),
        ),
      ],
    };
  }

  async handleComponent(
    identity: LearnerIdentity,
    customId: string,
  ): Promise<LearnerReply> {
    const [action, argument = ""] = customId.split(/:(.*)/s) as [
      string,
      string?,
    ];
    switch (action) {
      case "learner_optin":
        return this.cadenceChoice("얼마나 자주 받아볼까요?");
      case "learner_change":
        return this.cadenceChoice("어떤 빈도로 바꿀까요?");
      case "learner_cadence": {
        if (!isLearnerCadence(argument))
          return { content: "알 수 없는 선택입니다." };
        if (identity.guildId) {
          await this.store.learnerSubscribe({
            userId: identity.userId,
            guildId: identity.guildId,
            cadence: argument,
          });
          return {
            content: `${CADENCE_LABEL[argument]} 받기로 했어요. 소식이 준비되면 DM으로 보낼게요. 서버 멤버가 보낸 DM을 막아 두셨다면 열어 주세요. 그만 받고 싶으면 받은 DM의 [그만 받기]를 누르면 돼요.`,
          };
        }
        const changed = await this.store.learnerSetCadence(
          identity.userId,
          argument,
        );
        return {
          content: changed
            ? `이제 ${CADENCE_LABEL[argument]} 받아요.`
            : "구독 중이 아니에요. 안내 메시지의 [학습자 소식 DM으로 받기]를 눌러 다시 신청해 주세요.",
        };
      }
      case "learner_optout": {
        const done = await this.store.learnerOptOut(identity.userId);
        return {
          content: done
            ? "더 이상 소식을 보내지 않을게요. 다시 받고 싶으면 안내 메시지의 버튼을 눌러 주세요."
            : "이미 구독 중이 아니에요.",
        };
      }
      case "learner_email": {
        if (argument !== "yes" && argument !== "no")
          return { content: "알 수 없는 선택입니다." };
        const done = await this.store.learnerSetEmailInterest(
          identity.userId,
          argument === "yes",
        );
        return {
          content: !done
            ? "구독 중이 아니에요."
            : argument === "yes"
              ? "고마워요. 메일로 받을 수 있게 되면 알려 드릴게요."
              : "알겠어요. 계속 DM으로 보낼게요.",
        };
      }
      case "learner_issue_send":
      case "learner_issue_skip": {
        if (!this.options.superadminIds.includes(identity.userId))
          return { content: "운영자만 쓸 수 있는 버튼입니다." };
        return action === "learner_issue_send"
          ? { content: await this.sendIssue(argument, identity.userId) }
          : { content: await this.skipIssue(argument, identity.userId) };
      }
      default:
        return { content: "알 수 없는 버튼입니다." };
    }
  }

  /** Resolves a click token to the stored URL and records the click. */
  async resolveLink(
    token: string,
    now = new Date(),
    userAgent = "",
  ): Promise<string | null> {
    const link = verifyLearnerLink(this.key, token, now);
    if (!link) return null;
    const url = safeLearnerUrl(await this.store.learnerItemUrl(link.itemId));
    if (!url) return null;
    // Link-preview fetchers must not count as the learner's click.
    if (!/bot|crawler|spider|preview|slurp/i.test(userAgent))
      await this.store.learnerRecordClick(link.itemId, link.userId);
    return url;
  }

  async buildItems(since: Date): Promise<LearnerItemDraft[]> {
    const posts = await this.store.learnerCandidatePosts(since, FEEDS);
    const items: LearnerItemDraft[] = [];
    let freeModels = 0;
    let freeModelsKey = "";
    for (const post of posts) {
      if (post.key.startsWith("free-model:")) {
        freeModels += 1;
        freeModelsKey ||= post.key;
        continue;
      }
      const item = learnerItemFromPost(post);
      if (item) items.push(item);
    }
    if (freeModels)
      items.push({
        postKey: freeModelsKey,
        section: "core",
        title: `새 무료 모델 ${freeModels}개`,
        summary: "OpenRouter에 새로 올라온 무료 모델이에요.",
        url: FREE_MODELS_URL,
      });
    return selectLearnerItems(items);
  }

  /** Called every minute by the worker: builds due issues, sends previews and the weekly report. */
  async runDue(now = new Date()): Promise<void> {
    for (const cadence of ["daily", "weekly"] as const) {
      const boundary = learnerIssueBoundary(cadence, now);
      if (await this.store.learnerIssueExists(cadence, boundary.key)) continue;
      const windowStart =
        (await this.store.learnerLastWindowEnd(cadence)) ??
        new Date(now.getTime() - PERIOD_MS[cadence]);
      const items = await this.buildItems(windowStart);
      await this.store.learnerCreateIssue({
        cadence,
        periodKey: boundary.key,
        windowStart,
        windowEnd: now,
        items,
      });
    }
    for (const id of await this.store.learnerIssuesAwaitingPreview())
      await this.sendPreview(id);
    await this.reportIfDue(now);
  }

  private async sendPreview(issueId: string): Promise<void> {
    const issue = await this.store.learnerIssue(issueId);
    if (!issue) return;
    const subscribers = await this.store.learnerActiveSubscribers(
      issue.cadence,
    );
    const lines = [
      `**학습자 소식 ${CADENCE_LABEL[issue.cadence]} · ${issue.periodKey}** — 발송 전 확인`,
      `받을 사람 ${subscribers.length}명`,
      ...issue.items.map(
        (item) =>
          `• [${item.section === "core" ? "핵심" : "도구"}] ${item.title.slice(0, 80)}\n  <${item.url}>`,
      ),
    ];
    let delivered = 0;
    for (const adminId of this.options.superadminIds) {
      try {
        await this.delivery.send(
          { channel: "discord_dm", recipientId: adminId },
          {
            subject: "학습자 소식 미리보기",
            text: "",
            html: "",
            itemIds: [],
            discord: {
              embeds: [],
              content: fit(lines.join("\n"), 1900),
              flags: 4,
              components: [
                row(
                  button("발송", `learner_issue_send:${issue.id}`, 3),
                  button("건너뛰기", `learner_issue_skip:${issue.id}`, 2),
                ),
              ],
            },
          },
          `learner-preview:${issue.id}:${adminId}`,
        );
        delivered += 1;
      } catch {
        // Retried on the next tick while the issue is recent.
      }
    }
    if (delivered) await this.store.learnerMarkPreviewSent(issue.id);
  }

  async skipIssue(issueId: string, actorId: string): Promise<string> {
    if (await this.store.learnerDecideIssue(issueId, "skipped", actorId))
      return "이번 호는 건너뛰었어요.";
    return stateMessage(await this.store.learnerIssueState(issueId));
  }

  /** Sends an approved issue; the state claim makes a second press a no-op. */
  async sendIssue(issueId: string, actorId: string): Promise<string> {
    if (!(await this.store.learnerDecideIssue(issueId, "sending", actorId)))
      return stateMessage(await this.store.learnerIssueState(issueId));
    const issue = await this.store.learnerIssue(issueId);
    if (!issue) return "호를 찾지 못했어요.";
    const subscribers = await this.store.learnerActiveSubscribers(
      issue.cadence,
    );
    for (const subscriber of subscribers) {
      try {
        const result = await this.delivery.send(
          { channel: "discord_dm", recipientId: subscriber.userId },
          {
            subject: "학습자 소식",
            text: "",
            html: "",
            itemIds: [],
            discord: this.issueMessage(issue, subscriber),
          },
          `learner:${issue.id}:${subscriber.userId}`,
        );
        await this.store.learnerRecordDelivery({
          issueId: issue.id,
          userId: subscriber.userId,
          state: "sent",
          providerId: result.providerId,
        });
        if (!subscriber.emailAsked)
          await this.store.learnerMarkEmailAsked(subscriber.userId);
      } catch (error) {
        await this.store.learnerRecordDelivery({
          issueId: issue.id,
          userId: subscriber.userId,
          state: "failed",
          error: (error instanceof Error ? error.message : "failed").slice(
            0,
            200,
          ),
        });
      }
      if (this.options.pauseMs !== 0)
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.pauseMs ?? 300),
        );
    }
    await this.store.learnerFinishIssue(issue.id);
    await this.options.onIssueSent?.(issue).catch(() => undefined);
    const counts = await this.store.learnerDeliveryCounts(issue.id);
    return `발송했어요. 성공 ${counts.sent}명 · 실패 ${counts.failed}명`;
  }

  issueMessage(
    issue: {
      cadence: LearnerCadence;
      periodKey: string;
      items: Array<{
        id: string;
        section: "core" | "tools";
        title: string;
        url: string;
      }>;
    },
    subscriber: { userId: string; emailAsked: boolean },
    now = new Date(),
  ): {
    embeds: unknown[];
    components: unknown[];
    content: string;
    flags: number;
  } {
    const lines = [`**라피 학습자 소식 · ${issue.periodKey}**`];
    for (const section of LEARNER_SECTIONS) {
      const items = issue.items.filter((item) => item.section === section.id);
      if (!items.length) continue;
      lines.push("", `**${section.label}**`);
      for (const item of items) {
        const link = `${this.options.baseUrl.replace(/\/+$/, "")}/r/${signLearnerLink(this.key, item.id, subscriber.userId, now)}`;
        const line = `• [${item.title.replace(/[[\]]/g, "").slice(0, 60)}](<${link}>)`;
        if (lines.join("\n").length + line.length > CONTENT_BUDGET) break;
        lines.push(line);
      }
    }
    const buttons = [
      button("빈도 바꾸기", "learner_change"),
      button("그만 받기", "learner_optout"),
      ...(subscriber.emailAsked
        ? []
        : [
            button("메일로도 받고 싶어요", "learner_email:yes", 1),
            button("DM이면 충분해요", "learner_email:no"),
          ]),
    ];
    return {
      embeds: [],
      content: lines.join("\n"),
      // Suppress link previews so a crawler fetch is not mistaken for a click.
      flags: 4,
      components: [row(...buttons)],
    };
  }

  private async reportIfDue(now: Date): Promise<void> {
    const boundary = learnerReportBoundary(now);
    if (!(await this.store.learnerReportClaim(boundary.key))) return;
    const from = new Date(boundary.at.getTime() - PERIOD_MS.weekly);
    const text = await this.report(from, boundary.at, boundary.key);
    for (const adminId of this.options.superadminIds)
      try {
        await this.delivery.send(
          { channel: "discord_dm", recipientId: adminId },
          { subject: "학습자 실험 주간 리포트", text, html: "", itemIds: [] },
          `learner-report:${boundary.key}:${adminId}`,
        );
      } catch {
        // The report is not retried; the next week's report covers the totals.
      }
  }

  async report(from: Date, to: Date, label: string): Promise<string> {
    const data = await this.store.learnerReportData(from, to);
    const verdict = learnerVerdict({
      activeSubscribers: data.active,
      weeklyClickers: data.clickers,
      replies: data.repliesTotal,
      optOuts: data.optOutsTotal,
      emailYes: data.emailYes,
      emailNo: data.emailNo,
    });
    const percent =
      verdict.clickRate === null
        ? "-"
        : `${Math.round(verdict.clickRate * 100)}%`;
    return [
      `**학습자 DM 실험 주간 리포트 · ${label}**`,
      `구독자: ${data.active}명 (매일 ${data.daily} · 매주 ${data.weekly})`,
      `옵트아웃: 이번 주 ${data.optOutsWeek}명 · 누적 ${data.optOutsTotal}명`,
      `링크 클릭: 이번 주 1회 이상 ${data.clickers}명 (${percent})`,
      `자발적 답장: 이번 주 ${data.repliesWeek}건 · 누적 ${data.repliesTotal}건 (공유는 직접 확인)`,
      `메일 의향: 예 ${data.emailYes} · 아니오 ${data.emailNo} · 미응답 ${data.emailUnknown}`,
      `판정: **${verdict.label}** → ${verdict.action}`,
      ...(verdict.emailBranch ? [`분기: ${verdict.emailBranch}`] : []),
      "기준: 클릭 30%↑·답장 2건↑·옵트아웃 1명↓ 성공 / 클릭 10%↓ 또는 옵트아웃 2명↑ 중단 (답장·옵트아웃은 누적)",
    ].join("\n");
  }
}

function fit(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function stateMessage(state: string | null): string {
  switch (state) {
    case "sending":
    case "sent":
      return "이미 발송한 호예요.";
    case "skipped":
      return "이미 건너뛴 호예요.";
    case null:
      return "호를 찾지 못했어요.";
    default:
      return "처리할 수 없는 상태예요.";
  }
}

/** Builds the experiment only when the flag is on and its secrets are configured. */
export function createLearnerExperiment(
  config: {
    LEARNER_EXPERIMENT_ENABLED: boolean;
    WEBHOOK_ENCRYPTION_KEY?: string | undefined;
    RAPI_PUBLIC_BASE_URL?: string | undefined;
    DISCORD_SUPERADMIN_USER_IDS?: string[] | undefined;
  },
  store: LearnerStore,
  delivery: DeliveryAdapter,
  hooks: Pick<LearnerExperimentOptions, "onIssueSent"> = {},
): LearnerExperiment | undefined {
  if (
    !config.LEARNER_EXPERIMENT_ENABLED ||
    !config.WEBHOOK_ENCRYPTION_KEY ||
    !config.RAPI_PUBLIC_BASE_URL ||
    !config.DISCORD_SUPERADMIN_USER_IDS?.length
  )
    return undefined;
  return new LearnerExperiment(store, delivery, {
    superadminIds: config.DISCORD_SUPERADMIN_USER_IDS,
    linkSecret: config.WEBHOOK_ENCRYPTION_KEY,
    baseUrl: config.RAPI_PUBLIC_BASE_URL,
    ...(hooks.onIssueSent ? { onIssueSent: hooks.onIssueSent } : {}),
  });
}
