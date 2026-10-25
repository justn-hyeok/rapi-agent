import { randomBytes } from "node:crypto";
import { escapeHtml as h } from "@rapi/core";

export interface WebResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export interface WebNavAccount {
  username: string;
  displayName: string | null;
  role: string;
  /** CSRF token for the logout form. */
  csrf: string;
}

export interface WebNavLink {
  href: string;
  label: string;
}

export interface WebPageInput {
  title: string;
  body: string;
  account?: WebNavAccount | undefined;
  /** Extra nav entries, e.g. admin pages added by a later lane. */
  nav?: WebNavLink[] | undefined;
  status?: number;
  /** Public pages (the archive) may be indexed; everything else is noindex. */
  indexable?: boolean;
  headers?: Record<string, string | string[]>;
}

const STYLE = `
:root{--bg:#fafaf8;--fg:#1c1c1a;--muted:#6b6b66;--line:#e2e2dc;--card:#fff;--accent:#2f5bea;--accent-fg:#fff;--warn:#a15c00}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--muted:#9a9a94;--line:#2c2c29;--card:#1e1e1c;--accent:#7b9cff;--accent-fg:#101010;--warn:#e0a24a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:16px}
header.top{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;padding:8px 0 16px;border-bottom:1px solid var(--line);margin-bottom:24px}
header.top a.brand{font-weight:700;color:var(--fg);text-decoration:none}
nav{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center}
nav a{color:var(--muted);text-decoration:none}
nav a:hover{color:var(--fg)}
nav form{display:inline;margin:0}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 8px}
h2{font-size:1.1rem;margin:28px 0 8px}
p{margin:8px 0}
.muted{color:var(--muted);font-size:.9rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
.note{border-left:3px solid var(--warn);padding:4px 12px;margin:12px 0}
fieldset{border:0;padding:0;margin:12px 0}
legend{font-weight:600;margin-bottom:4px}
label.opt{display:flex;gap:8px;align-items:center;min-height:44px}
label.opt.off{color:var(--muted)}
button,a.btn{display:inline-block;min-height:44px;padding:8px 18px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer;text-decoration:none}
button.primary,a.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
button.link{min-height:0;padding:0;border:0;background:none;color:var(--muted)}
ul.plain{list-style:none;padding:0;margin:0}
ul.plain li{border-bottom:1px solid var(--line)}
ul.plain a{display:block;padding:12px 0;color:var(--fg);text-decoration:none}
.item h3{font-size:1rem;margin:0 0 4px}
.item a{color:var(--accent)}
.tag{font-size:.8rem;color:var(--muted)}
`;

/** Renders a full page and the strict-CSP headers; scripts are never emitted. */
export function webPage(input: WebPageInput): WebResponse {
  const nonce = randomBytes(16).toString("base64");
  const nav: WebNavLink[] = [
    { href: "/me", label: "내 구독" },
    { href: "/archive", label: "아카이브" },
    ...(input.nav ?? []),
  ];
  const account = input.account;
  const auth = account
    ? `<span class="muted">${h(account.displayName ?? account.username)}</span><form method="post" action="/logout"><input type="hidden" name="csrf" value="${h(account.csrf)}"><button class="link" type="submit">로그아웃</button></form>`
    : `<a href="/auth/discord/login">Discord로 로그인</a>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${input.indexable ? "" : '<meta name="robots" content="noindex">'}<meta name="referrer" content="no-referrer"><title>${h(input.title)} · 라피</title><style nonce="${nonce}">${STYLE}</style></head><body><div class="wrap"><header class="top"><a class="brand" href="/archive">라피</a><nav>${nav.map((link) => `<a href="${h(link.href)}">${h(link.label)}</a>`).join("")}${auth}</nav></header><main>${input.body}</main></div></body></html>`;
  return {
    status: input.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...(input.indexable ? {} : { "x-robots-tag": "noindex" }),
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      ...input.headers,
    },
    body: html,
  };
}

export function redirect(
  location: string,
  headers: Record<string, string | string[]> = {},
  status = 303,
): WebResponse {
  return {
    status,
    headers: { location, "cache-control": "no-store", ...headers },
    body: "",
  };
}

export function messagePage(
  status: number,
  title: string,
  text: string,
  account?: WebNavAccount,
): WebResponse {
  return webPage({
    title,
    status,
    account,
    body: `<h1>${h(title)}</h1><p>${h(text)}</p>`,
  });
}
