import type {
  DeliveryAdapter,
  DeliveryPayload,
  DeliveryResult,
  DeliveryTarget,
  EmailProvider,
} from "@rapi/core";
import { PermanentDeliveryError, UncertainDeliveryError } from "./delivery.js";

export interface EmailMessage {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  idempotencyKey: string;
}

/** The narrow seam to a transactional email provider's HTTP API. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<{ providerId: string }>;
}

type FetchLike = typeof fetch;

/** 4xx (except 408/429) will not succeed on retry; 5xx/429 might, but the caller records and moves on. */
function statusError(provider: string, status: number): Error {
  const message = `${provider} returned ${status}`;
  return status >= 400 && status < 500 && status !== 408 && status !== 429
    ? new PermanentDeliveryError(message)
    : new Error(message);
}

async function post(
  fetcher: FetchLike,
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // The request may have reached the provider; never retry blindly.
    throw new UncertainDeliveryError(
      `${provider} delivery outcome is uncertain`,
      { cause: error },
    );
  }
  if (!response.ok) throw statusError(provider, response.status);
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw new UncertainDeliveryError(
      `${provider} delivery acknowledgement is uncertain`,
      { cause: error },
    );
  }
}

export class ResendEmailTransport implements EmailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async send(message: EmailMessage): Promise<{ providerId: string }> {
    const result = await post(
      this.fetcher,
      "Resend",
      "https://api.resend.com/emails",
      {
        authorization: `Bearer ${this.apiKey}`,
        "idempotency-key": message.idempotencyKey,
      },
      {
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        headers: message.headers,
      },
    );
    if (typeof result.id !== "string" || !result.id)
      throw new UncertainDeliveryError("Resend response has no message id");
    return { providerId: result.id };
  }
}

export class PostmarkEmailTransport implements EmailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly messageStream = "outbound",
  ) {}

  async send(message: EmailMessage): Promise<{ providerId: string }> {
    const result = await post(
      this.fetcher,
      "Postmark",
      "https://api.postmarkapp.com/email",
      { "x-postmark-server-token": this.apiKey, accept: "application/json" },
      {
        From: message.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        HtmlBody: message.html,
        ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
        Headers: Object.entries(message.headers).map(([Name, Value]) => ({
          Name,
          Value,
        })),
        MessageStream: this.messageStream,
      },
    );
    if (result.ErrorCode !== 0 && result.ErrorCode !== undefined)
      throw new PermanentDeliveryError(
        `Postmark rejected the message (${JSON.stringify(result.ErrorCode)})`,
      );
    if (typeof result.MessageID !== "string" || !result.MessageID)
      throw new UncertainDeliveryError("Postmark response has no message id");
    return { providerId: result.MessageID };
  }
}

export function createEmailTransport(
  provider: EmailProvider,
  apiKey: string,
  options: { fetcher?: FetchLike; postmarkStream?: string | undefined } = {},
): EmailTransport {
  const fetcher = options.fetcher ?? fetch;
  return provider === "resend"
    ? new ResendEmailTransport(apiKey, fetcher)
    : new PostmarkEmailTransport(
        apiKey,
        fetcher,
        options.postmarkStream || "outbound",
      );
}

/** Test fake that records messages; `failures` holds addresses that must fail. */
export class MemoryEmailTransport implements EmailTransport {
  readonly messages: EmailMessage[] = [];
  readonly failures = new Set<string>();

  async send(message: EmailMessage): Promise<{ providerId: string }> {
    if (this.failures.has(message.to))
      throw new Error("Injected email failure");
    this.messages.push(message);
    return { providerId: `memory:${message.idempotencyKey}` };
  }
}

export class EmailDeliveryAdapter implements DeliveryAdapter {
  constructor(
    private readonly transport: EmailTransport,
    private readonly options: { from: string; replyTo?: string | undefined },
  ) {}

  async send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
    idempotencyKey: string,
  ): Promise<DeliveryResult> {
    if (target.channel !== "email")
      throw new Error("Email adapter received a non-email target");
    for (const value of [
      target.recipientId,
      payload.subject,
      this.options.from,
      ...Object.values(payload.emailHeaders ?? {}),
    ])
      if (/[\r\n]/.test(value))
        throw new Error("Email header contains a newline");
    const result = await this.transport.send({
      from: this.options.from,
      to: target.recipientId,
      ...(this.options.replyTo ? { replyTo: this.options.replyTo } : {}),
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      headers: payload.emailHeaders ?? {},
      idempotencyKey,
    });
    return { providerId: result.providerId };
  }
}
