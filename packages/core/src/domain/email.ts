import { escapeHtml } from "./web.js";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Verification links live 24 hours; unsubscribe links must keep working in old mail. */
export const EMAIL_VERIFY_HOURS = 24;
export const EMAIL_UNSUBSCRIBE_DAYS = 3650;
/** After this many soft bounces an address is treated as dead. */
export const EMAIL_SOFT_BOUNCE_LIMIT = 5;
const WEBHOOK_TOLERANCE_SECONDS = 300;

export type EmailTokenPurpose = "verify" | "unsub";
export const EMAIL_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d{10}\.[\w-]{43}$/;

/** Domain-separated key so mail links never reuse the learner click-link key. */
export function emailTokenKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("rapi-email-v1").digest();
}

function emailSignature(
  key: Buffer,
  purpose: EmailTokenPurpose,
  addressId: string,
  expires: number,
): string {
  return createHmac("sha256", key)
    .update(`${purpose}.${addressId}.${expires}`)
    .digest("base64url");
}

/**
 * The token names a stored address row, never the address itself. The purpose
 * is signed but not carried, so a verify token cannot be replayed as an
 * unsubscribe token. Single use is a database fact (see EmailStore.verify).
 */
export function signEmailToken(
  key: Buffer,
  purpose: EmailTokenPurpose,
  addressId: string,
  now = new Date(),
): string {
  const seconds =
    purpose === "verify"
      ? EMAIL_VERIFY_HOURS * 3600
      : EMAIL_UNSUBSCRIBE_DAYS * 86400;
  const expires = Math.floor(now.getTime() / 1000) + seconds;
  return `${addressId}.${expires}.${emailSignature(key, purpose, addressId, expires)}`;
}

/** Pure check of shape, signature and expiry; returns the address row id. */
export function verifyEmailToken(
  key: Buffer,
  purpose: EmailTokenPurpose,
  token: string,
  now = new Date(),
): { addressId: string } | null {
  if (!EMAIL_TOKEN_PATTERN.test(token)) return null;
  const [addressId, expiresText, given] = token.split(".") as [
    string,
    string,
    string,
  ];
  const expires = Number(expiresText);
  if (expires * 1000 < now.getTime()) return null;
  const expected = Buffer.from(
    emailSignature(key, purpose, addressId, expires),
  );
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  return { addressId };
}

/** A conservative address check: ASCII only, no display names, no header injection. */
export function parseEmailAddress(raw: string): string | null {
  const value = raw.trim();
  if (value.length > 254) return null;
  const match =
    /^([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64})@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/.exec(
      value,
    );
  if (!match) return null;
  const [, local, domain] = match as unknown as [string, string, string];
  if (local.startsWith(".") || local.endsWith(".") || local.includes(".."))
    return null;
  return `${local}@${domain.toLowerCase()}`;
}

export interface EmailIssueItem {
  section: "core" | "tools";
  title: string;
  summary: string;
  /** The tracked `/r/<token>` link, never the original URL. */
  link: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

const SECTION_LABEL = { core: "핵심", tools: "도구 입문" } as const;

export function unsubscribeHeaders(
  unsubscribeUrl: string,
): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** Plain HTML and text versions of a learner issue with the one-click unsubscribe footer. */
export function renderLearnerIssueEmail(input: {
  periodKey: string;
  cadenceLabel: string;
  items: EmailIssueItem[];
  unsubscribeUrl: string;
}): RenderedEmail {
  const subject = `라피 학습자 소식 · ${input.periodKey}`;
  const text: string[] = [subject, ""];
  const html: string[] = [
    `<h1 style="font-size:20px">${escapeHtml(subject)}</h1>`,
  ];
  for (const section of ["core", "tools"] as const) {
    const items = input.items.filter((item) => item.section === section);
    if (!items.length) continue;
    text.push(`[${SECTION_LABEL[section]}]`);
    html.push(`<h2 style="font-size:16px">${SECTION_LABEL[section]}</h2><ul>`);
    for (const item of items) {
      text.push(`- ${item.title}`);
      if (item.summary) text.push(`  ${item.summary}`);
      text.push(`  ${item.link}`);
      html.push(
        `<li><a href="${escapeHtml(item.link)}">${escapeHtml(item.title)}</a>${
          item.summary ? `<br>${escapeHtml(item.summary)}` : ""
        }</li>`,
      );
    }
    text.push("");
    html.push("</ul>");
  }
  const footer = `${input.cadenceLabel} 받기로 신청해서 보내 드린 메일이에요. 더 받고 싶지 않으면 아래 링크에서 바로 그만 받을 수 있어요.`;
  text.push("--", footer, `메일 그만 받기: ${input.unsubscribeUrl}`);
  html.push(
    `<hr><p style="font-size:12px;color:#666">${escapeHtml(footer)}<br><a href="${escapeHtml(input.unsubscribeUrl)}">메일 그만 받기</a></p>`,
  );
  return {
    subject,
    text: text.join("\n"),
    html: `<!doctype html><html lang="ko"><body>${html.join("")}</body></html>`,
    headers: unsubscribeHeaders(input.unsubscribeUrl),
  };
}

export function renderVerificationEmail(input: {
  verifyUrl: string;
}): RenderedEmail {
  const subject = "라피 학습자 소식 메일 주소 확인";
  const text = [
    "라피 학습자 소식을 이 메일 주소로 받으려면 아래 링크를 열고 [확인] 버튼을 눌러 주세요.",
    "링크는 24시간 동안만 쓸 수 있어요.",
    input.verifyUrl,
    "",
    "직접 신청하지 않았다면 이 메일을 무시해 주세요. 아무것도 보내지 않아요.",
  ].join("\n");
  const html = `<!doctype html><html lang="ko"><body><p>라피 학습자 소식을 이 메일 주소로 받으려면 아래 링크를 열고 [확인] 버튼을 눌러 주세요. 링크는 24시간 동안만 쓸 수 있어요.</p><p><a href="${escapeHtml(input.verifyUrl)}">메일 주소 확인하기</a></p><p style="font-size:12px;color:#666">직접 신청하지 않았다면 이 메일을 무시해 주세요. 아무것도 보내지 않아요.</p></body></html>`;
  return { subject, text, html, headers: {} };
}

export type EmailProvider = "resend" | "postmark";
export type EmailSuppressionKind = "hard" | "soft" | "complaint";

export interface EmailWebhookEvent {
  address: string;
  kind: EmailSuppressionKind;
}

function addressesOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const bracket = /<([^<>]+)>\s*$/.exec(entry);
    const parsed = parseEmailAddress(bracket ? bracket[1]! : entry);
    return parsed ? [parsed] : [];
  });
}

/**
 * Maps a provider event to suppression events. Hard bounces and complaints
 * stop sending; soft bounces only count. Unknown events yield nothing.
 */
export function parseEmailWebhook(
  provider: EmailProvider,
  body: unknown,
): EmailWebhookEvent[] {
  if (!body || typeof body !== "object") return [];
  const event = body as Record<string, unknown>;
  if (provider === "resend") {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const addresses = addressesOf(data.to);
    if (event.type === "email.complained")
      return addresses.map((address) => ({ address, kind: "complaint" }));
    if (event.type === "email.bounced") {
      const bounce = (data.bounce ?? {}) as Record<string, unknown>;
      const kind = bounce.type === "Permanent" ? "hard" : "soft";
      return addresses.map((address) => ({ address, kind }));
    }
    return [];
  }
  const addresses = addressesOf(event.Email);
  if (event.RecordType === "SpamComplaint")
    return addresses.map((address) => ({ address, kind: "complaint" }));
  if (
    event.RecordType === "SubscriptionChange" &&
    event.SuppressSending === true
  )
    return addresses.map((address) => ({ address, kind: "hard" }));
  if (event.RecordType !== "Bounce") return [];
  if (event.Type === "SpamNotification" || event.Type === "SpamComplaint")
    return addresses.map((address) => ({ address, kind: "complaint" }));
  const hard =
    event.TypeCode === 1 ||
    event.Type === "HardBounce" ||
    event.Type === "BadEmailAddress" ||
    event.Type === "ManuallyDeactivated";
  return addresses.map((address) => ({
    address,
    kind: hard ? "hard" : "soft",
  }));
}

function safeEqual(a: string, b: string): boolean {
  const left = createHmac("sha256", "cmp").update(a).digest();
  const right = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Resend signs webhooks with Svix: HMAC-SHA256 over `id.timestamp.body` with
 * the base64 key behind the `whsec_` prefix, sent as space separated `v1,<sig>`.
 */
export function verifyResendWebhook(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
  now = new Date(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp))
    return false;
  if (
    Math.abs(now.getTime() / 1000 - Number(timestamp)) >
    WEBHOOK_TOLERANCE_SECONDS
  )
    return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (!key.length) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  return signature
    .split(" ")
    .some(
      (part) => part.startsWith("v1,") && safeEqual(part.slice(3), expected),
    );
}

/** Postmark does not sign webhooks; the endpoint is guarded by HTTP Basic auth (`user:password`). */
export function verifyPostmarkWebhook(
  secret: string,
  authorization: string | undefined,
): boolean {
  if (!authorization || !secret.includes(":")) return false;
  return safeEqual(
    authorization,
    `Basic ${Buffer.from(secret).toString("base64")}`,
  );
}
