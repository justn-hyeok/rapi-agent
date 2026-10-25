import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  resolveDiscordAccess,
  type DiscordAccessLevel,
  type DiscordAllowlists,
} from "./access.js";

export const WEB_SESSION_DAYS = 30;
export const WEB_OAUTH_STATE_SECONDS = 600;
export const WEB_UNSUBSCRIBE_DAYS = 180;

export type WebRole = "USER" | "ADMIN" | "SUPERADMIN";

const ROLE_BY_LEVEL: Record<DiscordAccessLevel, WebRole> = {
  user: "USER",
  admin: "ADMIN",
  superadmin: "SUPERADMIN",
};
const ROLE_RANK: Record<WebRole, number> = { USER: 1, ADMIN: 2, SUPERADMIN: 3 };

/**
 * Every logged-in Discord account is at least USER on the web; ADMIN and
 * SUPERADMIN come from the same user-id allowlists the Discord commands use.
 */
export function webRole(
  userId: string,
  allowlists: DiscordAllowlists,
): WebRole {
  try {
    return ROLE_BY_LEVEL[resolveDiscordAccess({ userId }, allowlists).level];
  } catch {
    return "USER";
  }
}

export function webRoleAtLeast(actual: WebRole, required: WebRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

function domainKey(secret: string, domain: string): Buffer {
  return createHmac("sha256", secret).update(domain).digest();
}

export const webSessionKey = (secret: string): Buffer =>
  domainKey(secret, "rapi-web-session-v1");
export const webUnsubscribeKey = (secret: string): Buffer =>
  domainKey(secret, "rapi-web-unsubscribe-v1");

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const newWebSessionId = (): string =>
  randomBytes(32).toString("base64url");

/** Only this hash is stored; the cookie carries the raw id. */
export const hashWebSessionId = (id: string): string =>
  createHash("sha256").update(id).digest("hex");

/** Per-session CSRF token for POST forms; nothing is stored. */
export function webCsrfToken(key: Buffer, sessionId: string): string {
  return sign(key, `csrf.${sessionId}`);
}

export function verifyWebCsrf(
  key: Buffer,
  sessionId: string,
  given: string | null | undefined,
): boolean {
  return (
    typeof given === "string" && equal(webCsrfToken(key, sessionId), given)
  );
}

export interface WebOAuthState {
  state: string;
  verifier: string;
  challenge: string;
}

/** CSRF `state` plus a PKCE verifier/challenge pair for the Discord login. */
export function newWebOAuthState(): WebOAuthState {
  const verifier = randomBytes(32).toString("base64url");
  return {
    state: randomBytes(24).toString("base64url"),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** The pending login lives in a short-lived signed cookie, so no table is needed. */
export function signWebOAuthCookie(
  key: Buffer,
  value: { state: string; verifier: string },
  now: Date,
): string {
  const expires = Math.floor(now.getTime() / 1000) + WEB_OAUTH_STATE_SECONDS;
  const payload = `${value.state}.${value.verifier}.${expires}`;
  return `${payload}.${sign(key, `oauth.${payload}`)}`;
}

export function verifyWebOAuthCookie(
  key: Buffer,
  cookie: string | undefined,
  givenState: string | null,
  now: Date,
): { verifier: string } | null {
  const match = /^([\w-]{32})\.([\w-]{43})\.(\d{10})\.([\w-]{43})$/.exec(
    cookie ?? "",
  );
  if (!match || !givenState) return null;
  const [, state, verifier, expires, given] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (Number(expires) * 1000 < now.getTime()) return null;
  const payload = `${state}.${verifier}.${expires}`;
  if (!equal(sign(key, `oauth.${payload}`), given)) return null;
  if (!equal(state, givenState)) return null;
  return { verifier };
}

/** Unsubscribe link without login: names the Discord user and expires. */
export function signWebUnsubscribe(
  key: Buffer,
  userId: string,
  now = new Date(),
): string {
  const expires =
    Math.floor(now.getTime() / 1000) + WEB_UNSUBSCRIBE_DAYS * 86400;
  return `${userId}.${expires}.${sign(key, `unsubscribe.${userId}.${expires}`)}`;
}

export function verifyWebUnsubscribe(
  key: Buffer,
  token: string,
  now = new Date(),
): { userId: string } | null {
  const match = /^(\d{15,20})\.(\d{10})\.([\w-]{43})$/.exec(token);
  if (!match) return null;
  const [, userId, expires, given] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (Number(expires) * 1000 < now.getTime()) return null;
  if (!equal(sign(key, `unsubscribe.${userId}.${expires}`), given)) return null;
  return { userId };
}

export interface CookieOptions {
  maxAgeSeconds: number;
  /** Cookies are always HttpOnly, Secure and SameSite=Lax. */
  path?: string;
}

export function serializeWebCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  return `${name}=${value}; Path=${options.path ?? "/"}; Max-Age=${options.maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function parseWebCookies(
  header: string | undefined,
): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
