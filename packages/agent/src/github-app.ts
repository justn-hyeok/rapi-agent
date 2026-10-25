import type { IncomingHttpHeaders } from "node:http";
import type { GitHubAppClient, ModelClient } from "@rapi/adapters";
import {
  buildRepoReport,
  classifyGitHubEvent,
  reportDue,
  verifyGitHubSignature,
  type DeliveryAdapter,
  type GitHubAccessPolicy,
  type RepoWeekData,
} from "@rapi/core";
import type { GitHubDelivery } from "@rapi/db";

export interface GitHubWebhookPorts {
  store: { enqueue(delivery: GitHubDelivery): Promise<boolean> };
  secret: string;
  policy: GitHubAccessPolicy;
}

export interface WebhookResult {
  status: number;
  body: unknown;
}

/**
 * Verifies, filters and queues a GitHub webhook. Nothing runs here: the ChatOps
 * process claims queued deliveries and runs them through the shared engine.
 */
export class GitHubWebhookReceiver {
  constructor(private readonly ports: GitHubWebhookPorts) {}

  async receive(
    body: Buffer,
    headers: IncomingHttpHeaders,
  ): Promise<WebhookResult> {
    const signature = headers["x-hub-signature-256"];
    if (
      typeof signature !== "string" ||
      !verifyGitHubSignature(body, signature, this.ports.secret)
    )
      return { status: 401, body: { error: "invalid signature" } };
    const event = headers["x-github-event"];
    const deliveryId = headers["x-github-delivery"];
    if (
      typeof event !== "string" ||
      typeof deliveryId !== "string" ||
      !deliveryId
    )
      return { status: 400, body: { error: "missing github headers" } };
    if (event === "ping") return { status: 200, body: { pong: true } };
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid json" } };
    }
    const result = classifyGitHubEvent(event, payload, this.ports.policy);
    if (result.kind === "forbidden_owner")
      return { status: 403, body: { error: result.reason } };
    // Non-owner commenters are ignored silently: replying would let strangers
    // make the App post on the owner's public repos.
    if (result.kind === "ignore" || result.kind === "stranger")
      return { status: 200, body: { ignored: true } };
    const inserted = await this.ports.store.enqueue({
      deliveryId,
      event,
      repo: result.request.repo,
      request: result.request,
    });
    return inserted
      ? { status: 202, body: { queued: true } }
      : { status: 200, body: { duplicate: true } };
  }
}

export interface GitHubReportPorts {
  store: { claimReport(weekKey: string): Promise<boolean> };
  app: Pick<
    GitHubAppClient,
    | "listInstallations"
    | "installationRepos"
    | "repoWeek"
    | "reportIssue"
    | "comment"
  >;
  delivery: DeliveryAdapter;
  allowedOwners: readonly string[];
  superadminIds: readonly string[];
  target: "dm" | "issue";
  /** Optional summary; the report is complete without it. */
  model?: ModelClient | undefined;
}

export const REPORT_ISSUE_TITLE = "Rapi 주간 리포트";

/** Monday 09:00 Asia/Seoul summary of every installed, allowed repository. */
export class GitHubWeeklyReport {
  constructor(private readonly ports: GitHubReportPorts) {}

  /** Returns the number of repositories reported, or 0 when nothing was due. */
  async runDue(now: Date): Promise<number> {
    const boundary = reportDue(now);
    if (!boundary || !(await this.ports.store.claimReport(boundary.key)))
      return 0;
    const since = new Date(boundary.start.getTime() - 7 * 86_400_000);
    const sections: { repo: string; installationId: number; text: string }[] =
      [];
    for (const installation of await this.ports.app.listInstallations()) {
      if (
        !this.ports.allowedOwners.some(
          (owner) => owner.toLowerCase() === installation.account.toLowerCase(),
        )
      )
        continue;
      for (const repo of await this.ports.app.installationRepos(
        installation.id,
      )) {
        let text: string;
        try {
          const data: RepoWeekData = await this.ports.app.repoWeek(
            installation.id,
            repo,
            since,
          );
          text = buildRepoReport(data);
        } catch {
          text = `**${repo}**\n- GitHub 조회에 실패해 이번 주 요약을 만들지 못했습니다.`;
        }
        sections.push({ repo, installationId: installation.id, text });
      }
    }
    if (!sections.length) return 0;
    const summary = await this.summarize(
      sections.map((s) => s.text).join("\n\n"),
    );
    const body = [
      `**Rapi GitHub 주간 리포트 (${boundary.key})**`,
      ...(summary ? [`요약: ${summary}`] : []),
      ...sections.map((s) => s.text),
    ].join("\n\n");
    for (const adminId of this.ports.superadminIds)
      try {
        await this.ports.delivery.send(
          { channel: "discord_dm", recipientId: adminId },
          { subject: "GitHub 주간 리포트", text: body, html: "", itemIds: [] },
          `github-report:${boundary.key}:${adminId}`,
        );
      } catch {
        // Not retried; next week's report covers the current state.
      }
    if (this.ports.target === "issue")
      for (const section of sections)
        try {
          const number = await this.ports.app.reportIssue(
            section.installationId,
            section.repo,
            REPORT_ISSUE_TITLE,
          );
          await this.ports.app.comment(
            section.installationId,
            section.repo,
            number,
            `**주간 리포트 (${boundary.key})**\n\n${section.text}`,
          );
        } catch {
          // The DM above already carries this repository's section.
        }
    return sections.length;
  }

  private async summarize(facts: string): Promise<string | undefined> {
    if (!this.ports.model) return undefined;
    try {
      const reply = await this.ports.model.complete({
        feature: "repo_report",
        system:
          "저장소 주간 현황 데이터를 두세 문장의 한국어로 요약한다. 데이터에 없는 내용은 만들지 않는다.",
        messages: [{ role: "user", content: facts.slice(0, 12_000) }],
        maxOutputTokens: 300,
      });
      return reply.text.trim().slice(0, 600) || undefined;
    } catch {
      // Budget exhausted or the gateway is down: the deterministic report stands.
      return undefined;
    }
  }
}

export function createGitHubReport(
  config: {
    GITHUB_APP_ENABLED: boolean;
    GITHUB_APP_ALLOWED_OWNERS?: string[] | undefined;
    GITHUB_REPORT_TARGET: "dm" | "issue";
    DISCORD_SUPERADMIN_USER_IDS?: string[] | undefined;
  },
  ports: Pick<GitHubReportPorts, "store" | "app" | "delivery" | "model">,
): GitHubWeeklyReport | undefined {
  if (
    !config.GITHUB_APP_ENABLED ||
    !config.GITHUB_APP_ALLOWED_OWNERS?.length ||
    !config.DISCORD_SUPERADMIN_USER_IDS?.length
  )
    return undefined;
  return new GitHubWeeklyReport({
    ...ports,
    allowedOwners: config.GITHUB_APP_ALLOWED_OWNERS,
    superadminIds: config.DISCORD_SUPERADMIN_USER_IDS,
    target: config.GITHUB_REPORT_TARGET,
  });
}
