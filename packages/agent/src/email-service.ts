import {
  escapeHtml,
  learnerLinkKey,
  emailTokenKey,
  parseEmailAddress,
  parseEmailWebhook,
  renderLearnerIssueEmail,
  renderVerificationEmail,
  signEmailToken,
  signLearnerLink,
  verifyEmailToken,
  verifyPostmarkWebhook,
  verifyResendWebhook,
  type DeliveryAdapter,
  type EmailProvider,
  type LearnerCadence,
  type RenderedEmail,
} from "@rapi/core";
import type { EmailStore } from "@rapi/db";

type EmailServiceStore = Pick<
  EmailStore,
  | "register"
  | "claimVerificationSend"
  | "byId"
  | "verify"
  | "unsubscribe"
  | "suppress"
  | "recipients"
  | "claimDelivery"
  | "finishDelivery"
  | "deliveryCounts"
>;

export interface EmailServiceOptions {
  /** Secret both the mail-link key and the click-link key are derived from. */
  linkSecret: string;
  /** Public origin whose gateway forwards `/e/...` and `/r/...` to the bot. */
  baseUrl: string;
  provider: EmailProvider;
  /** Resend: the `whsec_` signing secret. Postmark: `user:password` of the webhook's Basic auth. */
  webhookSecret: string;
  /** Called after an address was registered, e.g. to record email interest. */
  onRegistered?: (userId: string) => Promise<void>;
  pauseMs?: number;
  verificationCooldownMs?: number;
}

export interface EmailPage {
  status: number;
  html: string;
}

export interface EmailIssue {
  id: string;
  cadence: LearnerCadence;
  periodKey: string;
  items: Array<{
    id: string;
    section: "core" | "tools";
    title: string;
    summary?: string;
    url: string;
  }>;
}

const CADENCE_LABEL: Record<LearnerCadence, string> = {
  daily: "매일",
  weekly: "매주",
};

function page(status: number, title: string, body: string): EmailPage {
  return {
    status,
    html: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>${body}</body></html>`,
  };
}

const message = (text: string) => `<p>${escapeHtml(text)}</p>`;
const confirmForm = (label: string) =>
  `<form method="post"><button type="submit" style="font-size:1rem;padding:.5rem 1rem">${escapeHtml(label)}</button></form>`;

export class EmailService {
  private readonly tokenKey: Buffer;
  private readonly clickKey: Buffer;

  constructor(
    private readonly store: EmailServiceStore,
    private readonly delivery: DeliveryAdapter,
    private readonly options: EmailServiceOptions,
  ) {
    this.tokenKey = emailTokenKey(options.linkSecret);
    this.clickKey = learnerLinkKey(options.linkSecret);
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private async deliver(
    to: string,
    mail: RenderedEmail,
    idempotencyKey: string,
  ): Promise<string> {
    const result = await this.delivery.send(
      { channel: "email", recipientId: to },
      {
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        itemIds: [],
        emailHeaders: mail.headers,
      },
      idempotencyKey,
    );
    return result.providerId;
  }

  /** Stores the address and mails a verification link; returns the ephemeral Discord reply. */
  async register(
    userId: string,
    raw: string,
    now = new Date(),
  ): Promise<string> {
    const address = parseEmailAddress(raw);
    if (!address)
      return "메일 주소 형식이 올바르지 않아요. 영문 주소(예: name@example.com)로 다시 입력해 주세요.";
    const row = await this.store.register(userId, address);
    await this.options.onRegistered?.(userId);
    if (row.bounceState === "hard" || row.bounceState === "complaint")
      return "이 주소로는 메일을 보낼 수 없어요. 다른 주소로 다시 등록해 주세요.";
    if (row.verified)
      return "이미 확인된 주소예요. 다음 호부터 이 주소로도 보내 드릴게요.";
    const claimed = await this.store.claimVerificationSend(
      row.id,
      now,
      this.options.verificationCooldownMs ?? 600_000,
    );
    if (!claimed)
      return "확인 메일을 방금 보냈어요. 메일함(스팸함 포함)을 확인해 보시고, 10분 뒤에도 안 오면 다시 등록해 주세요.";
    const token = signEmailToken(this.tokenKey, "verify", row.id, now);
    try {
      await this.deliver(
        address,
        renderVerificationEmail({ verifyUrl: this.url(`/e/verify/${token}`) }),
        `email-verify:${row.id}:${Math.floor(now.getTime() / 1000)}`,
      );
    } catch {
      return "확인 메일을 보내지 못했어요. 주소를 확인하고 잠시 뒤에 다시 시도해 주세요.";
    }
    return "확인 메일을 보냈어요. 24시간 안에 메일의 링크를 열어 확인해 주세요. 확인하면 다음 호부터 메일로도 받아요.";
  }

  private invalidLink(): EmailPage {
    return page(
      404,
      "링크를 열 수 없어요",
      message(
        "링크가 만료됐거나 올바르지 않아요. 디스코드에서 메일 주소를 다시 등록해 새 확인 메일을 받아 주세요.",
      ),
    );
  }

  /**
   * GET shows a confirm button and changes nothing, so a mail scanner that
   * opens the link cannot consume the single-use token. POST confirms.
   */
  async verifyLink(
    token: string,
    method: "GET" | "POST",
    now = new Date(),
  ): Promise<EmailPage> {
    const checked = verifyEmailToken(this.tokenKey, "verify", token, now);
    if (!checked) return this.invalidLink();
    if (method === "GET")
      return page(
        200,
        "메일 주소 확인",
        message(
          "아래 버튼을 눌러 이 주소로 학습자 소식을 받겠다고 확인해 주세요.",
        ) + confirmForm("확인"),
      );
    const result = await this.store.verify(checked.addressId);
    if (result === "missing") return this.invalidLink();
    return page(
      200,
      result === "verified" ? "확인했어요" : "이미 확인한 링크예요",
      message(
        "다음 호부터 이 주소로도 학습자 소식을 보내 드릴게요. 메일 맨 아래 링크로 언제든 그만 받을 수 있어요.",
      ),
    );
  }

  /**
   * GET shows the confirm page; POST unsubscribes. The POST also serves the
   * RFC 8058 one-click request that mail clients send without a page view.
   */
  async unsubscribeLink(
    token: string,
    method: "GET" | "POST",
    now = new Date(),
  ): Promise<EmailPage> {
    const checked = verifyEmailToken(this.tokenKey, "unsub", token, now);
    if (!checked) return this.invalidLink();
    if (method === "GET")
      return page(
        200,
        "메일 그만 받기",
        message(
          "아래 버튼을 누르면 이 주소로 학습자 소식을 더 보내지 않아요.",
        ) + confirmForm("그만 받기"),
      );
    if (!(await this.store.unsubscribe(checked.addressId)))
      return this.invalidLink();
    return page(
      200,
      "그만 받기로 했어요",
      message(
        "이 주소로는 더 이상 보내지 않아요. 디스코드 DM은 그대로 오고, 다시 받고 싶으면 디스코드에서 메일 주소를 등록해 주세요.",
      ),
    );
  }

  /** Verifies the provider's signature, then applies bounce and complaint events. */
  async webhook(
    provider: string,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    now = new Date(),
  ): Promise<{ status: number }> {
    if (provider !== this.options.provider) return { status: 404 };
    const header = (name: string): string | undefined => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const verified =
      provider === "resend"
        ? verifyResendWebhook(
            this.options.webhookSecret,
            {
              ...(header("svix-id") ? { id: header("svix-id")! } : {}),
              ...(header("svix-timestamp")
                ? { timestamp: header("svix-timestamp")! }
                : {}),
              ...(header("svix-signature")
                ? { signature: header("svix-signature")! }
                : {}),
            },
            rawBody,
            now,
          )
        : verifyPostmarkWebhook(
            this.options.webhookSecret,
            header("authorization"),
          );
    if (!verified) return { status: 401 };
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { status: 400 };
    }
    for (const event of parseEmailWebhook(provider as EmailProvider, body))
      await this.store.suppress(event.address, event.kind);
    return { status: 200 };
  }

  /** Mails an approved, sent issue to verified addresses; one attempt each, failures recorded. */
  async sendIssue(
    issue: EmailIssue,
    now = new Date(),
  ): Promise<{ sent: number; failed: number }> {
    const recipients = await this.store.recipients(issue.cadence, issue.id);
    for (const recipient of recipients) {
      if (!(await this.store.claimDelivery(issue.id, recipient.emailId)))
        continue;
      try {
        const unsubscribeToken = signEmailToken(
          this.tokenKey,
          "unsub",
          recipient.emailId,
          now,
        );
        const mail = renderLearnerIssueEmail({
          periodKey: issue.periodKey,
          cadenceLabel: CADENCE_LABEL[issue.cadence],
          unsubscribeUrl: this.url(`/e/unsub/${unsubscribeToken}`),
          items: issue.items.map((item) => ({
            section: item.section,
            title: item.title,
            summary: item.summary ?? "",
            link: this.url(
              `/r/${signLearnerLink(this.clickKey, item.id, recipient.userId, now)}`,
            ),
          })),
        });
        const providerId = await this.deliver(
          recipient.email,
          mail,
          `learner-email:${issue.id}:${recipient.emailId}`,
        );
        await this.store.finishDelivery({
          issueId: issue.id,
          emailId: recipient.emailId,
          state: "sent",
          providerId,
        });
      } catch (error) {
        await this.store.finishDelivery({
          issueId: issue.id,
          emailId: recipient.emailId,
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
    return this.store.deliveryCounts(issue.id);
  }
}

/** Builds the email channel only when the flag is on and everything it needs is configured. */
export function createEmailService(
  config: {
    EMAIL_ENABLED: boolean;
    EMAIL_PROVIDER?: EmailProvider | undefined;
    EMAIL_WEBHOOK_SECRET?: string | undefined;
    WEBHOOK_ENCRYPTION_KEY?: string | undefined;
    RAPI_PUBLIC_BASE_URL?: string | undefined;
  },
  store: EmailServiceStore,
  delivery: DeliveryAdapter,
  onRegistered?: (userId: string) => Promise<void>,
): EmailService | undefined {
  if (
    !config.EMAIL_ENABLED ||
    !config.EMAIL_PROVIDER ||
    !config.EMAIL_WEBHOOK_SECRET ||
    !config.WEBHOOK_ENCRYPTION_KEY ||
    !config.RAPI_PUBLIC_BASE_URL
  )
    return undefined;
  return new EmailService(store, delivery, {
    linkSecret: config.WEBHOOK_ENCRYPTION_KEY,
    baseUrl: config.RAPI_PUBLIC_BASE_URL,
    provider: config.EMAIL_PROVIDER,
    webhookSecret: config.EMAIL_WEBHOOK_SECRET,
    ...(onRegistered ? { onRegistered } : {}),
  });
}
