import {
  WEB_OAUTH_STATE_SECONDS,
  WEB_SESSION_DAYS,
  escapeHtml as h,
  hashWebSessionId,
  isLearnerCadence,
  newWebOAuthState,
  newWebSessionId,
  parseWebCookies,
  safeLearnerUrl,
  serializeWebCookie,
  signWebOAuthCookie,
  signWebUnsubscribe,
  verifyWebCsrf,
  verifyWebOAuthCookie,
  verifyWebUnsubscribe,
  webCsrfToken,
  webRole,
  webRoleAtLeast,
  webSessionKey,
  webUnsubscribeKey,
  type DiscordAllowlists,
  type LearnerCadence,
  type WebRole,
} from "@rapi/core";
import type {
  BlogPostsStore,
  PostgresStore,
  PublishedBlogPost,
  WebArchiveIssue,
  WebStore,
} from "@rapi/db";
import type { EmailAddressStatus } from "./email-service.js";
import { renderBlogMdx } from "./web-blog.js";
import {
  WEB_ADMIN_NAV,
  webAdminRoutes,
  type WebAdminOptions,
} from "./web-admin.js";
import {
  messagePage,
  redirect,
  webPage,
  type WebNavAccount,
  type WebNavLink,
  type WebResponse,
} from "./web-layout.js";

export type { WebResponse } from "./web-layout.js";

const SESSION_COOKIE = "__Host-rapi_session";
const OAUTH_COOKIE = "__Host-rapi_oauth";
const DISCORD_API = "https://discord.com/api/v10";
const CADENCE_LABEL: Record<LearnerCadence, string> = {
  daily: "매일",
  weekly: "매주",
};
const ARCHIVE_LIMIT = 60;

export interface WebRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  query: URLSearchParams;
  cookie?: string | undefined;
  /** Parsed urlencoded body of a POST; empty otherwise. */
  form: URLSearchParams;
}

/**
 * Past issues for `/archive`. The optional post methods add published blog
 * guides next to them; a source without them lists issues only.
 */
export interface ArchiveSource {
  list(limit: number): Promise<WebArchiveIssue[]>;
  get(slug: string): Promise<WebArchiveIssue | null>;
  listPosts?(limit: number): Promise<PublishedBlogPost[]>;
  getPost?(slug: string): Promise<PublishedBlogPost | null>;
}

/** Sent issues plus published blog guides; withdrawn posts never reach it. */
export function createArchiveSource(
  issues: Pick<WebStore, "archiveIssues" | "archiveIssue">,
  blog?: Pick<BlogPostsStore, "listPublishedBlogPosts" | "getBlogPost">,
): ArchiveSource {
  return {
    list: (limit) => issues.archiveIssues(limit),
    get: (slug) => issues.archiveIssue(slug),
    ...(blog
      ? {
          // Issue posts are the same issues as above; only guides are new here.
          listPosts: async (limit) =>
            (await blog.listPublishedBlogPosts(limit)).filter(
              (post) => post.kind !== "issue",
            ),
          getPost: (slug) => blog.getBlogPost(slug),
        }
      : {}),
  };
}

/** The `/me` email card; backed by the email channel's service (`EMAIL_ENABLED`). */
export interface WebEmailPort {
  status(userId: string): Promise<EmailAddressStatus | null>;
  /** Returns the same reply text the Discord modal shows. */
  register(userId: string, address: string): Promise<string>;
  remove(userId: string): Promise<boolean>;
}

export type WebPortalStore = Pick<
  WebStore,
  | "upsertAccount"
  | "createSession"
  | "sessionAccount"
  | "deleteSession"
  | "learnerSubscription"
>;
type LearnerWriter = Pick<
  PostgresStore,
  "learnerSubscribe" | "learnerSetCadence" | "learnerOptOut"
>;

export interface WebPortalOptions {
  /** `RAPI_PUBLIC_BASE_URL`; the OAuth redirect URI is derived from it. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Secret the session, CSRF and unsubscribe keys are derived from. */
  secret: string;
  allowlists: DiscordAllowlists;
  /** Whether the learner DM experiment sends anything; the form is disabled otherwise. */
  learnerEnabled: boolean;
  emailEnabled: boolean;
  /** Present when the email channel is configured; enables the `/me` address card. */
  email?: WebEmailPort;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Routes added by later lanes (admin pages). */
  routes?: WebRoute[];
  nav?: WebNavLink[];
}

export interface WebAccount {
  userId: string;
  username: string;
  displayName: string | null;
  role: WebRole;
  sessionId: string;
  csrf: string;
}

export interface WebRouteContext {
  request: WebRequest;
  match: RegExpExecArray;
  now: Date;
  /** Present for every route whose `access` is not "public" and for public routes with a session. */
  account: WebAccount | undefined;
  portal: WebPortal;
}

/**
 * One entry of the route table. `access: "public"` needs no login; a role
 * name makes the dispatcher answer 401/403 before the handler runs, which is
 * the `requireRole` guard admin pages hang off.
 */
export interface WebRoute {
  method: "GET" | "POST";
  pattern: RegExp;
  access: "public" | WebRole;
  handler: (context: WebRouteContext) => Promise<WebResponse>;
}

export const WEB_PATH_PATTERN =
  /^\/(?:auth\/|me(?:\/|$)|admin(?:\/|$)|archive(?:\/|$)|u\/|logout$)/;

export class WebPortal {
  private readonly sessionKey: Buffer;
  private readonly unsubscribeKey: Buffer;
  private readonly redirectUri: string;
  private readonly now: () => Date;
  private readonly http: typeof fetch;
  private readonly routes: WebRoute[];

  constructor(
    readonly store: WebPortalStore,
    private readonly learner: LearnerWriter,
    private readonly archive: ArchiveSource,
    private readonly options: WebPortalOptions,
  ) {
    this.sessionKey = webSessionKey(options.secret);
    this.unsubscribeKey = webUnsubscribeKey(options.secret);
    this.redirectUri = `${options.baseUrl.replace(/\/+$/, "")}/auth/discord/callback`;
    this.now = options.now ?? (() => new Date());
    this.http = options.fetch ?? fetch;
    this.routes = [...this.builtinRoutes(), ...(options.routes ?? [])];
  }

  /** CSRF check for admin pages that read their own session. */
  verifyCsrf(account: WebAccount, request: WebRequest): boolean {
    return this.csrfOk(account, request);
  }

  /** Link an owner can put in a DM: unsubscribes without a login. */
  unsubscribeUrl(userId: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, "")}/u/${signWebUnsubscribe(this.unsubscribeKey, userId, this.now())}`;
  }

  /** Returns undefined for paths this portal does not own. */
  async handle(request: WebRequest): Promise<WebResponse | undefined> {
    if (!WEB_PATH_PATTERN.test(request.path)) return undefined;
    const now = this.now();
    let methodMismatch = false;
    for (const route of this.routes) {
      const match = route.pattern.exec(request.path);
      if (!match) continue;
      if (route.method !== request.method) {
        methodMismatch = true;
        continue;
      }
      const account = await this.account(request, now);
      if (route.access !== "public") {
        if (!account)
          return request.method === "GET"
            ? this.loginPage()
            : messagePage(
                401,
                "로그인이 필요해요",
                "로그인한 뒤 다시 시도해 주세요.",
              );
        if (!webRoleAtLeast(account.role, route.access))
          return messagePage(
            403,
            "권한이 없어요",
            `${route.access} 권한이 필요한 페이지예요.`,
            this.nav(account),
          );
      }
      return route.handler({ request, match, now, account, portal: this });
    }
    return methodMismatch
      ? { status: 405, headers: { allow: "GET, POST" }, body: "" }
      : undefined;
  }

  nav(account: WebAccount | undefined): WebNavAccount | undefined {
    return account
      ? {
          username: account.username,
          displayName: account.displayName,
          role: account.role,
          csrf: account.csrf,
        }
      : undefined;
  }

  page(
    account: WebAccount | undefined,
    input: Omit<Parameters<typeof webPage>[0], "account" | "nav">,
  ): WebResponse {
    return webPage({
      ...input,
      account: this.nav(account),
      nav: this.options.nav,
    });
  }

  private async account(
    request: WebRequest,
    now: Date,
  ): Promise<WebAccount | undefined> {
    const sessionId = parseWebCookies(request.cookie).get(SESSION_COOKIE);
    if (!sessionId || !/^[\w-]{43}$/.test(sessionId)) return undefined;
    const record = await this.store.sessionAccount(
      hashWebSessionId(sessionId),
      now,
    );
    if (!record) return undefined;
    return {
      ...record,
      role: webRole(record.userId, this.options.allowlists),
      sessionId,
      csrf: webCsrfToken(this.sessionKey, sessionId),
    };
  }

  private csrfOk(account: WebAccount, request: WebRequest): boolean {
    return verifyWebCsrf(
      this.sessionKey,
      account.sessionId,
      request.form.get("csrf"),
    );
  }

  private loginPage(): WebResponse {
    return this.page(undefined, {
      title: "로그인",
      status: 401,
      body: `<h1>내 구독</h1><p>구독 설정은 Discord 계정으로 로그인해야 볼 수 있어요. 계정 이름만 확인하고 서버 목록이나 메시지는 읽지 않아요.</p><p><a class="btn primary" href="/auth/discord/login">Discord로 로그인</a></p>`,
    });
  }

  private builtinRoutes(): WebRoute[] {
    return [
      {
        method: "GET",
        pattern: /^\/auth\/discord\/login$/,
        access: "public",
        handler: (c) => this.login(c),
      },
      {
        method: "GET",
        pattern: /^\/auth\/discord\/callback$/,
        access: "public",
        handler: (c) => this.callback(c),
      },
      {
        method: "POST",
        pattern: /^\/logout$/,
        access: "public",
        handler: (c) => this.logout(c),
      },
      {
        method: "GET",
        pattern: /^\/me$/,
        access: "USER",
        handler: (c) => this.me(c),
      },
      {
        method: "POST",
        pattern: /^\/me\/subscription$/,
        access: "USER",
        handler: (c) => this.subscribe(c),
      },
      {
        method: "GET",
        pattern: /^\/archive$/,
        access: "public",
        handler: (c) => this.archiveList(c),
      },
      {
        method: "POST",
        pattern: /^\/me\/email$/,
        access: "USER",
        handler: (c) => this.emailAddress(c),
      },
      {
        method: "GET",
        pattern: /^\/archive\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)$/,
        access: "public",
        handler: (c) => this.archivePost(c),
      },
      {
        method: "GET",
        pattern: /^\/archive\/([a-z]+-[\d-]{10})$/,
        access: "public",
        handler: (c) => this.archiveIssue(c),
      },
      {
        method: "GET",
        pattern: /^\/u\/([\w.-]{1,200})$/,
        access: "public",
        handler: (c) => this.unsubscribePage(c),
      },
      {
        method: "POST",
        pattern: /^\/u\/([\w.-]{1,200})$/,
        access: "public",
        handler: (c) => this.unsubscribe(c),
      },
    ];
  }

  private async login({ now }: WebRouteContext): Promise<WebResponse> {
    const oauth = newWebOAuthState();
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      response_type: "code",
      scope: "identify",
      redirect_uri: this.redirectUri,
      state: oauth.state,
      code_challenge: oauth.challenge,
      code_challenge_method: "S256",
      prompt: "none",
    }).toString();
    return redirect(
      url.toString(),
      {
        "set-cookie": serializeWebCookie(
          OAUTH_COOKIE,
          signWebOAuthCookie(this.sessionKey, oauth, now),
          { maxAgeSeconds: WEB_OAUTH_STATE_SECONDS },
        ),
      },
      302,
    );
  }

  private async callback({
    request,
    now,
  }: WebRouteContext): Promise<WebResponse> {
    const clearOAuth = serializeWebCookie(OAUTH_COOKIE, "", {
      maxAgeSeconds: 0,
    });
    const fail = (status: number, text: string): WebResponse => {
      const page = messagePage(status, "로그인하지 못했어요", text);
      page.headers["set-cookie"] = clearOAuth;
      return page;
    };
    const pending = verifyWebOAuthCookie(
      this.sessionKey,
      parseWebCookies(request.cookie).get(OAUTH_COOKIE),
      request.query.get("state"),
      now,
    );
    if (!pending)
      return fail(
        400,
        "로그인 요청이 만료됐거나 올바르지 않아요. 처음부터 다시 시도해 주세요.",
      );
    const code = request.query.get("code");
    if (request.query.get("error") || !code || code.length > 512)
      return fail(400, "Discord 로그인이 취소됐어요. 다시 시도해 주세요.");
    let profile: { id: string; username: string; displayName: string | null };
    try {
      profile = await this.discordProfile(code, pending.verifier);
    } catch {
      return fail(
        502,
        "Discord와 통신하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
      );
    }
    await this.store.upsertAccount(
      {
        userId: profile.id,
        username: profile.username,
        displayName: profile.displayName,
      },
      now,
    );
    const sessionId = newWebSessionId();
    await this.store.createSession(
      hashWebSessionId(sessionId),
      profile.id,
      now,
      new Date(now.getTime() + WEB_SESSION_DAYS * 86_400_000),
    );
    return redirect("/me", {
      "set-cookie": [
        serializeWebCookie(SESSION_COOKIE, sessionId, {
          maxAgeSeconds: WEB_SESSION_DAYS * 86400,
        }),
        clearOAuth,
      ],
    });
  }

  private async discordProfile(code: string, verifier: string) {
    const token = await this.http(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenBody = (await token.json()) as { access_token?: unknown };
    if (!token.ok || typeof tokenBody.access_token !== "string")
      throw new Error("Discord token exchange failed");
    const me = await this.http(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await me.json()) as {
      id?: unknown;
      username?: unknown;
      global_name?: unknown;
    };
    if (
      !me.ok ||
      typeof body.id !== "string" ||
      !/^\d{15,20}$/.test(body.id) ||
      typeof body.username !== "string"
    )
      throw new Error("Discord profile lookup failed");
    return {
      id: body.id,
      username: body.username.slice(0, 80),
      displayName:
        typeof body.global_name === "string"
          ? body.global_name.slice(0, 80)
          : null,
    };
  }

  private async logout({
    request,
    now,
  }: WebRouteContext): Promise<WebResponse> {
    const account = await this.account(request, now);
    if (!account || !this.csrfOk(account, request))
      return messagePage(
        403,
        "요청을 확인하지 못했어요",
        "페이지를 새로 열고 다시 시도해 주세요.",
      );
    await this.store.deleteSession(hashWebSessionId(account.sessionId));
    return redirect("/archive", {
      "set-cookie": serializeWebCookie(SESSION_COOKIE, "", {
        maxAgeSeconds: 0,
      }),
    });
  }

  private async me(
    { request, account }: WebRouteContext,
    message?: string,
  ): Promise<WebResponse> {
    const user = account!;
    const email = this.options.email;
    const address = email ? await email.status(user.userId) : null;
    const subscription = await this.store.learnerSubscription(user.userId);
    const active = subscription?.active === true;
    const cadence = subscription?.cadence ?? "weekly";
    const notices: Record<string, string> = {
      subscribed: "구독했어요. 소식이 준비되면 Discord DM으로 보낼게요.",
      changed: "빈도를 바꿨어요.",
      unsubscribed: "구독을 해지했어요.",
      email:
        "메일 구독은 아직 준비 중이에요. 지금은 Discord DM만 받을 수 있어요.",
      emailcard: '메일 주소는 아래 "메일 주소" 카드에서 등록해 주세요.',
      off: "소식 발송이 아직 시작되지 않았어요. 시작되면 알려 드릴게요.",
      bad: "선택을 확인하지 못했어요. 다시 골라 주세요.",
      csrf: "요청을 확인하지 못했어요. 페이지를 새로 열고 다시 시도해 주세요.",
    };
    const notice = message ?? notices[request.query.get("m") ?? ""];
    const disabled = this.options.learnerEnabled ? "" : " disabled";
    const body = `<h1>내 구독</h1>
${notice ? `<p class="note">${h(notice)}</p>` : ""}
<div class="card"><p><strong>${h(user.displayName ?? user.username)}</strong> <span class="muted">${h(user.role)}</span></p>
<p>학습자 소식: ${active ? `<strong>${CADENCE_LABEL[cadence]} 받는 중</strong>` : "구독 안 함"}</p></div>
${this.options.learnerEnabled ? "" : '<p class="note">학습자 소식 발송이 아직 꺼져 있어요. 지금 구독해도 발송은 시작된 뒤부터예요.</p>'}
<form method="post" action="/me/subscription" class="card">
<input type="hidden" name="csrf" value="${h(user.csrf)}">
<fieldset><legend>트랙</legend><label class="opt"><input type="radio" name="track" value="learner" checked> 학습자 — 무료 토큰, 설정법, 쓸 만한 도구</label></fieldset>
<fieldset><legend>빈도</legend>
<label class="opt"><input type="radio" name="cadence" value="daily"${cadence === "daily" ? " checked" : ""}> 매일</label>
<label class="opt"><input type="radio" name="cadence" value="weekly"${cadence === "weekly" ? " checked" : ""}> 매주</label></fieldset>
<fieldset><legend>받을 곳</legend>
<label class="opt"><input type="radio" name="channel" value="discord_dm" checked> Discord DM</label>${
      email
        ? ""
        : `
<label class="opt off"><input type="radio" name="channel" value="email"${this.options.emailEnabled ? "" : " disabled"}> 이메일${this.options.emailEnabled ? "" : " (준비 중)"}</label>`
    }</fieldset>
<p><button class="primary" type="submit" name="action" value="subscribe"${disabled}>${active ? "바꾸기" : "구독하기"}</button>${active ? ' <button type="submit" name="action" value="unsubscribe">구독 해지</button>' : ""}</p>
<p class="muted">DM은 라피 봇과 같은 서버에 있고 서버 멤버의 DM을 허용해야 받을 수 있어요.</p>
</form>${email ? this.emailCard(user, address) : ""}`;
    return this.page(user, { title: "내 구독", body });
  }

  private emailCard(
    user: WebAccount,
    address: EmailAddressStatus | null,
  ): string {
    const states: Record<EmailAddressStatus["state"], string> = {
      pending:
        "확인 대기 중 — 메일함(스팸함 포함)의 확인 링크를 열고 [확인]을 눌러야 받아요.",
      verified: "확인됨 — 다음 호부터 이 주소로도 보내요.",
      unsubscribed:
        "수신 거부됨 — 주소를 다시 등록하면 새로 확인 메일을 보내요.",
      blocked: "이 주소로는 보낼 수 없어요 — 다른 주소로 등록해 주세요.",
    };
    return `
<form method="post" action="/me/email" class="card">
<input type="hidden" name="csrf" value="${h(user.csrf)}">
<h2>메일 주소</h2>
<p>${address ? `<strong>${h(address.masked)}</strong><br><span class="muted">${h(states[address.state])}</span>` : "등록한 주소가 없어요."}</p>
<p><label>주소 <input type="email" name="address" maxlength="254" autocomplete="email" placeholder="name@example.com"></label>
<button class="primary" type="submit" name="action" value="add">${address ? "주소 바꾸기" : "주소 등록"}</button>${address ? ' <button type="submit" name="action" value="remove">주소 삭제</button>' : ""}</p>
<p class="muted">메일은 구독 중일 때 DM과 함께 와요. 구독을 해지하면 메일도 멈춰요. 같은 주소로 확인 메일은 10분에 한 번만 보내요.</p>
</form>`;
  }

  private async emailAddress(context: WebRouteContext): Promise<WebResponse> {
    const { request, account } = context;
    const user = account!;
    const email = this.options.email;
    if (!email) return redirect("/me?m=email");
    if (!this.csrfOk(user, request)) return redirect("/me?m=csrf");
    const action = request.form.get("action");
    if (action === "remove") {
      const done = await email.remove(user.userId);
      return this.me(
        context,
        done ? "메일 주소를 지웠어요." : "지울 메일 주소가 없어요.",
      );
    }
    const address = request.form.get("address")?.trim() ?? "";
    if (action !== "add" || !address || address.length > 254)
      return this.me(
        context,
        "메일 주소를 확인하지 못했어요. 다시 입력해 주세요.",
      );
    return this.me(context, await email.register(user.userId, address));
  }

  private async subscribe({
    request,
    account,
  }: WebRouteContext): Promise<WebResponse> {
    const user = account!;
    const back = (code: string) => redirect(`/me?m=${code}`);
    if (!this.csrfOk(user, request)) return back("csrf");
    const action = request.form.get("action");
    if (action === "unsubscribe") {
      const done = await this.learner.learnerOptOut(user.userId);
      return back(done ? "unsubscribed" : "bad");
    }
    const cadence = request.form.get("cadence");
    if (
      action !== "subscribe" ||
      request.form.get("track") !== "learner" ||
      !isLearnerCadence(cadence)
    )
      return back("bad");
    const channel = request.form.get("channel") ?? "discord_dm";
    if (channel !== "discord_dm")
      return back(
        channel === "email"
          ? this.options.email
            ? "emailcard"
            : "email"
          : "bad",
      );
    if (!this.options.learnerEnabled) return back("off");
    const current = await this.store.learnerSubscription(user.userId);
    if (current?.active)
      await this.learner.learnerSetCadence(user.userId, cadence);
    else
      await this.learner.learnerSubscribe({
        userId: user.userId,
        guildId: null,
        cadence,
      });
    return back(current?.active ? "changed" : "subscribed");
  }

  private async archiveList({
    account,
  }: WebRouteContext): Promise<WebResponse> {
    const [issues, posts] = await Promise.all([
      this.archive.list(ARCHIVE_LIMIT),
      this.archive.listPosts?.(ARCHIVE_LIMIT) ?? [],
    ]);
    const entries = [
      ...issues.map((issue) => ({
        href: `/archive/${issue.slug}`,
        title: issueTitle(issue),
        at: issue.sentAt,
      })),
      ...posts.map((post) => ({
        href: `/archive/blog/${post.slug}`,
        title: post.title,
        at: post.publishedAt,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, ARCHIVE_LIMIT);
    const list = entries.length
      ? `<ul class="plain">${entries.map((entry) => `<li><a href="${h(entry.href)}">${h(entry.title)}<br><span class="muted">${h(formatDate(entry.at))}</span></a></li>`).join("")}</ul>`
      : '<p class="muted">아직 발송된 소식이 없어요.</p>';
    return this.page(account, {
      title: "아카이브",
      indexable: true,
      body: `<h1>지난 소식</h1><p class="muted">DM으로 보낸 학습자 소식과 라피가 쓴 가이드를 웹에서도 볼 수 있어요.</p>${list}`,
    });
  }

  private async archivePost({
    match,
    account,
  }: WebRouteContext): Promise<WebResponse> {
    const post = await this.archive.getPost?.(match[1]!);
    if (!post)
      return this.page(account, {
        title: "찾을 수 없어요",
        status: 404,
        body: '<h1>찾을 수 없어요</h1><p>없는 글이거나 내려간 글이에요. <a href="/archive">목록으로</a></p>',
      });
    return this.page(account, {
      title: post.title,
      indexable: true,
      body: `<p><a href="/archive">← 아카이브</a></p><h1>${h(post.title)}</h1><p class="muted">${h(formatDate(post.publishedAt))}</p>${renderBlogMdx(post.mdx)}`,
    });
  }

  private async archiveIssue({
    match,
    account,
  }: WebRouteContext): Promise<WebResponse> {
    const issue = await this.archive.get(match[1]!);
    if (!issue)
      return this.page(account, {
        title: "찾을 수 없어요",
        status: 404,
        body: '<h1>찾을 수 없어요</h1><p>없는 소식이거나 아직 발송되지 않았어요. <a href="/archive">목록으로</a></p>',
      });
    const sections = [
      ["core", "핵심"],
      ["tools", "도구"],
    ] as const;
    const body = sections
      .map(([key, label]) => {
        const items = issue.items.filter((item) => item.section === key);
        return items.length
          ? `<h2>${label}</h2>${items.map((item) => issueItem(item)).join("")}`
          : "";
      })
      .join("");
    return this.page(account, {
      title: issueTitle(issue),
      indexable: true,
      body: `<p><a href="/archive">← 아카이브</a></p><h1>${h(issueTitle(issue))}</h1><p class="muted">${h(formatDate(issue.sentAt))}</p>${body || '<p class="muted">항목이 없어요.</p>'}`,
    });
  }

  private invalidUnsubscribe(): WebResponse {
    return this.page(undefined, {
      title: "링크를 확인하지 못했어요",
      status: 404,
      body: '<h1>링크를 확인하지 못했어요</h1><p>링크가 만료됐거나 올바르지 않아요. <a href="/me">내 구독</a>에서 직접 해지할 수 있어요.</p>',
    });
  }

  private async unsubscribePage({
    match,
  }: WebRouteContext): Promise<WebResponse> {
    if (!verifyWebUnsubscribe(this.unsubscribeKey, match[1]!, this.now()))
      return this.invalidUnsubscribe();
    return this.page(undefined, {
      title: "구독 해지",
      body: `<h1>구독을 해지할까요?</h1><p>해지하면 학습자 소식 DM을 더 보내지 않아요. 언제든 다시 구독할 수 있어요.</p><form method="post" action="/u/${h(match[1]!)}"><button class="primary" type="submit">구독 해지</button></form>`,
    });
  }

  private async unsubscribe({ match }: WebRouteContext): Promise<WebResponse> {
    const token = verifyWebUnsubscribe(
      this.unsubscribeKey,
      match[1]!,
      this.now(),
    );
    if (!token) return this.invalidUnsubscribe();
    const done = await this.learner.learnerOptOut(token.userId);
    return this.page(undefined, {
      title: "구독 해지",
      body: `<h1>${done ? "해지했어요" : "이미 해지된 구독이에요"}</h1><p>더 이상 학습자 소식을 보내지 않아요. 다시 받고 싶으면 <a href="/me">내 구독</a>에서 구독할 수 있어요.</p>`,
    });
  }
}

function issueTitle(issue: WebArchiveIssue): string {
  return `학습자 소식 · ${CADENCE_LABEL[issue.cadence]} ${issue.periodKey}`;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "long",
  }).format(date);
}

function issueItem(item: WebArchiveIssue["items"][number]): string {
  const url = safeLearnerUrl(item.url);
  return `<article class="card item"><h3>${h(item.title)}</h3>${item.summary ? `<p>${h(item.summary)}</p>` : ""}${url ? `<p><a href="${h(url)}" target="_blank" rel="noopener noreferrer">원문 보기</a></p>` : ""}</article>`;
}

/** Builds the portal only when the flag is on and every secret it needs is set. */
export function createWebPortal(
  config: {
    WEB_ENABLED: boolean;
    DISCORD_OAUTH_CLIENT_ID?: string | undefined;
    DISCORD_OAUTH_CLIENT_SECRET?: string | undefined;
    RAPI_PUBLIC_BASE_URL?: string | undefined;
    WEBHOOK_ENCRYPTION_KEY?: string | undefined;
    LEARNER_EXPERIMENT_ENABLED: boolean;
    EMAIL_ENABLED: boolean;
  },
  allowlists: DiscordAllowlists,
  store: WebStore,
  learner: LearnerWriter,
  admin?: WebAdminOptions,
  extras: {
    blogPosts?: Pick<BlogPostsStore, "listPublishedBlogPosts" | "getBlogPost">;
    email?: WebEmailPort;
  } = {},
): WebPortal | undefined {
  if (
    !config.WEB_ENABLED ||
    !config.DISCORD_OAUTH_CLIENT_ID ||
    !config.DISCORD_OAUTH_CLIENT_SECRET ||
    !config.RAPI_PUBLIC_BASE_URL ||
    !config.WEBHOOK_ENCRYPTION_KEY
  )
    return undefined;
  return new WebPortal(
    store,
    learner,
    createArchiveSource(store, extras.blogPosts),
    {
      baseUrl: config.RAPI_PUBLIC_BASE_URL,
      clientId: config.DISCORD_OAUTH_CLIENT_ID,
      clientSecret: config.DISCORD_OAUTH_CLIENT_SECRET,
      secret: config.WEBHOOK_ENCRYPTION_KEY,
      allowlists,
      learnerEnabled: config.LEARNER_EXPERIMENT_ENABLED,
      emailEnabled: config.EMAIL_ENABLED && extras.email !== undefined,
      ...(config.EMAIL_ENABLED && extras.email ? { email: extras.email } : {}),
      ...(admin ? { routes: webAdminRoutes(admin), nav: WEB_ADMIN_NAV } : {}),
    },
  );
}
