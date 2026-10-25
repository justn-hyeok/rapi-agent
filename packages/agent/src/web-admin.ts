import { escapeHtml as h, type DiscordIdentity } from "@rapi/core";
import type { DiscordCommandResult } from "./discord-commands.js";
import type { WebNavLink, WebResponse } from "./web-layout.js";
import type { WebAccount, WebRoute, WebRouteContext } from "./web-portal.js";

export interface WebAdminOptions {
  /**
   * The same service the slash commands run through. Pages call it with an
   * identity built from the web account, so permission checks, scope rules and
   * business logic are the slash commands' own.
   */
  commands: {
    execute(
      identity: DiscordIdentity,
      command: { name: string; options: Record<string, unknown> },
    ): Promise<DiscordCommandResult>;
  };
  /** Guilds the bot answers in; undefined means no restriction. */
  guilds: () => Promise<readonly string[] | undefined>;
  homeGuildId?: string | undefined;
}

export const WEB_ADMIN_NAV: WebNavLink[] = [
  { href: "/admin", label: "관리", role: "ADMIN" },
];

type CommandName = Parameters<
  WebAdminOptions["commands"]["execute"]
>[1]["name"];

const GUILD_ID = /^\d{15,20}$/;
const SAFE_ID = /^[\w.:-]{1,128}$/;
const FIELD_MAX = 500;

const INDEX_ENTRIES = [
  ["/admin/subscribe", "운영자 브리핑 구독", "/구독", "ADMIN"],
  ["/admin/unsubscribe", "운영자 브리핑 구독 해제", "/구독해제", "ADMIN"],
  ["/admin/sources", "수집원 상태", "/수집원", "ADMIN"],
  ["/admin/deliveries", "발송내역", "/발송내역", "ADMIN"],
  ["/admin/status", "운영 상태", "/상태", "ADMIN"],
  ["/admin/usage", "AI 사용량", "/사용량", "USER"],
  ["/admin/usage-policy", "AI 사용 정책", "/사용정책", "ADMIN"],
  ["/admin/server-config", "서버 구성", "/서버구성", "SUPERADMIN"],
  ["/admin/webhooks", "웹훅 연결", "/웹훅", "SUPERADMIN"],
] as const;

const ACCESS_ERROR = /권한|not allowed|허용|운영자 서버|invalid/i;

function field(form: URLSearchParams, name: string): string {
  return (form.get(name) ?? "").trim().slice(0, FIELD_MAX);
}

function hidden(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${h(name)}" value="${h(value)}">`,
    )
    .join("");
}

function guildQuery(guild: string | undefined): string {
  return guild ? `?guild=${encodeURIComponent(guild)}` : "";
}

export function webAdminRoutes(options: WebAdminOptions): WebRoute[] {
  const identity = (
    account: WebAccount,
    guildId?: string,
  ): DiscordIdentity => ({
    userId: account.userId,
    ...(guildId ? { guildId } : {}),
  });

  /** Runs a slash command as the web account; permission errors come back as text. */
  async function run(
    account: WebAccount,
    name: CommandName,
    commandOptions: Record<string, unknown>,
    guildId?: string,
  ): Promise<
    | { ok: true; result: DiscordCommandResult }
    | { ok: false; status: number; message: string }
  > {
    try {
      const result = await options.commands.execute(
        identity(account, guildId),
        {
          name,
          options: commandOptions,
        },
      );
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "요청 처리 실패";
      return {
        ok: false,
        status: ACCESS_ERROR.test(message) ? 403 : 400,
        message: message.slice(0, 500),
      };
    }
  }

  const view = (
    c: WebRouteContext,
    title: string,
    body: string,
    status = 200,
  ): WebResponse =>
    c.portal.page(c.account, {
      title,
      status,
      body: `<p><a href="/admin">← 관리</a></p><h1>${h(title)}</h1>${body}`,
    });

  const failure = (
    c: WebRouteContext,
    title: string,
    status: number,
    message: string,
  ): WebResponse => view(c, title, `<p class="note">${h(message)}</p>`, status);

  const done = (
    c: WebRouteContext,
    title: string,
    result: DiscordCommandResult,
    back: string,
  ): WebResponse =>
    view(
      c,
      title,
      `<pre>${h(result.messages.join("\n"))}</pre><p><a class="btn" href="${h(back)}">돌아가기</a></p>`,
    );

  /** POST guard: a valid CSRF token is required before anything else runs. */
  const post =
    (
      title: string,
      handler: (c: WebRouteContext, user: WebAccount) => Promise<WebResponse>,
    ) =>
    async (c: WebRouteContext): Promise<WebResponse> => {
      const user = c.account!;
      if (!c.portal.verifyCsrf(user, c.request))
        return failure(
          c,
          title,
          403,
          "요청을 확인하지 못했어요. 페이지를 새로 열고 다시 시도해 주세요.",
        );
      return handler(c, user);
    };

  const confirmPage = (
    c: WebRouteContext,
    title: string,
    message: string,
    action: string,
    fields: Record<string, string>,
    back: string,
  ): WebResponse =>
    view(
      c,
      title,
      `<form method="post" action="${h(action)}" class="card"><p>${h(message)}</p><input type="hidden" name="csrf" value="${h(c.account!.csrf)}">${hidden({ ...fields, confirm: "1" })}<p><button class="primary" type="submit">확인</button> <a class="btn" href="${h(back)}">취소</a></p></form>`,
    );

  async function guildChoices(): Promise<string[]> {
    const allowed = await options.guilds();
    return [
      ...new Set([
        ...(options.homeGuildId ? [options.homeGuildId] : []),
        ...(allowed ?? []),
      ]),
    ];
  }

  /** Renders the guild picker; guild settings have no implicit guild on the web. */
  async function guildPicker(
    c: WebRouteContext,
    title: string,
    action: string,
    selected: string | undefined,
  ): Promise<WebResponse> {
    const choices = await guildChoices();
    const control = choices.length
      ? `<select name="guild" id="guild">${choices.map((id) => `<option value="${h(id)}"${id === selected ? " selected" : ""}>${h(id)}${id === options.homeGuildId ? " (운영자 서버)" : ""}</option>`).join("")}</select>`
      : '<input type="text" name="guild" id="guild" inputmode="numeric" pattern="[0-9]{15,20}" placeholder="서버 ID" required>';
    return view(
      c,
      title,
      `<form method="get" action="${h(action)}" class="card"><label class="field" for="guild">서버</label>${control}<p class="muted">Discord 서버 ID로 골라요. 해당 서버를 관리할 수 있는 계정만 쓸 수 있어요.</p><p><button class="primary" type="submit">열기</button></p></form>`,
    );
  }

  const selectedGuild = (c: WebRouteContext): string | undefined => {
    const value = c.request.query.get("guild") ?? c.request.form.get("guild");
    return value && GUILD_ID.test(value) ? value : undefined;
  };

  const csrf = (c: WebRouteContext): string =>
    `<input type="hidden" name="csrf" value="${h(c.account!.csrf)}">`;

  /** GET page that just shows one command's text output. */
  const textPage =
    (title: string, name: CommandName, needsGuild = false) =>
    async (c: WebRouteContext): Promise<WebResponse> => {
      const guild = needsGuild ? selectedGuild(c) : undefined;
      if (needsGuild && !guild)
        return guildPicker(c, title, c.request.path, undefined);
      const outcome = await run(c.account!, name, {}, guild);
      if (!outcome.ok)
        return failure(c, title, outcome.status, outcome.message);
      return view(
        c,
        title,
        `<pre>${h(outcome.result.messages.join("\n"))}</pre>`,
      );
    };

  const index = async (c: WebRouteContext): Promise<WebResponse> => {
    const rank = { USER: 1, ADMIN: 2, SUPERADMIN: 3 } as const;
    const mine = rank[c.account!.role];
    const items = INDEX_ENTRIES.filter(([, , , role]) => rank[role] <= mine);
    return c.portal.page(c.account, {
      title: "관리",
      body: `<h1>관리</h1><p class="muted">Discord slash 명령에서 옮겨 온 기능이에요. 권한 규칙은 명령과 같아요.</p><ul class="plain">${items.map(([href, label, command]) => `<li><a href="${h(href)}">${h(label)}<br><span class="muted">${h(command)}</span></a></li>`).join("")}</ul>`,
    });
  };

  const subscribeForm = (c: WebRouteContext): WebResponse =>
    view(
      c,
      "운영자 브리핑 구독",
      `<form method="post" action="/admin/subscribe" class="card">${csrf(c)}
<label class="field">이름<input type="text" name="name" maxlength="100" required></label>
<label class="field">분야 (쉼표로 구분)<input type="text" name="categories" maxlength="200"></label>
<label class="field">키워드 (쉼표로 구분)<input type="text" name="keywords" maxlength="200"></label>
<label class="field">주기<select name="cadence"><option value="매일">매일</option><option value="즉시">즉시</option><option value="매주">매주</option></select></label>
<p class="muted">운영자용 브리핑 구독이에요. 학습자 소식 구독은 /me의 “내 구독”에서 바꿔요. 브리핑은 Discord DM으로 와요.</p>
<p><button class="primary" type="submit">구독 저장</button></p></form>`,
    );

  const subscribe = post("운영자 브리핑 구독", async (c, user) => {
    const form = c.request.form;
    const outcome = await run(user, "subscribe", {
      name: field(form, "name"),
      categories: field(form, "categories"),
      keywords: field(form, "keywords"),
      cadence: field(form, "cadence"),
    });
    if (!outcome.ok)
      return failure(c, "운영자 브리핑 구독", outcome.status, outcome.message);
    return done(c, "운영자 브리핑 구독", outcome.result, "/admin/subscribe");
  });

  const unsubscribeForm = (c: WebRouteContext): WebResponse =>
    view(
      c,
      "운영자 브리핑 구독 해제",
      `<form method="post" action="/admin/unsubscribe" class="card">${csrf(c)}
<label class="field">구독 이름<input type="text" name="name" maxlength="100" required></label>
<p><button class="primary" type="submit">해제하기</button></p></form>`,
    );

  const unsubscribe = post("운영자 브리핑 구독 해제", async (c, user) => {
    const name = field(c.request.form, "name");
    if (!name)
      return failure(
        c,
        "운영자 브리핑 구독 해제",
        400,
        "구독 이름을 적어 주세요.",
      );
    if (c.request.form.get("confirm") !== "1")
      return confirmPage(
        c,
        "운영자 브리핑 구독 해제",
        `“${name}” 구독을 해제할까요?`,
        "/admin/unsubscribe",
        { name },
        "/admin/unsubscribe",
      );
    const outcome = await run(user, "unsubscribe", { name });
    if (!outcome.ok)
      return failure(
        c,
        "운영자 브리핑 구독 해제",
        outcome.status,
        outcome.message,
      );
    return done(
      c,
      "운영자 브리핑 구독 해제",
      outcome.result,
      "/admin/unsubscribe",
    );
  });

  const policy = async (c: WebRouteContext): Promise<WebResponse> => {
    const title = "AI 사용 정책";
    const guild = selectedGuild(c);
    if (!guild) return guildPicker(c, title, "/admin/usage-policy", undefined);
    const outcome = await run(
      c.account!,
      "usage_policy",
      { action: "조회" },
      guild,
    );
    if (!outcome.ok) return failure(c, title, outcome.status, outcome.message);
    return view(
      c,
      title,
      `<p class="muted">서버 ${h(guild)}</p><pre>${h(outcome.result.messages.join("\n"))}</pre>
<form method="post" action="/admin/usage-policy" class="card">${csrf(c)}${hidden({ guild })}
<p class="muted">바꿀 값만 채워요. 비워 두면 그대로예요.</p>
<label class="field">사용자 일일 한도 (1 이상)<input type="number" name="userDailyLimit" min="1" step="1"></label>
<label class="field">쿨다운 초 (0 이상)<input type="number" name="userCooldownSeconds" min="0" step="1"></label>
<label class="field">서버 일일 한도 (1 이상)<input type="number" name="globalDailyLimit" min="1" step="1"></label>
<label class="field">동시 실행 (1~8)<input type="number" name="globalConcurrency" min="1" max="8" step="1"></label>
<p><button class="primary" type="submit">정책 바꾸기</button></p></form>`,
    );
  };

  const policyUpdate = post("AI 사용 정책", async (c, user) => {
    const title = "AI 사용 정책";
    const guild = selectedGuild(c);
    if (!guild) return failure(c, title, 400, "서버를 골라 주세요.");
    const values: Record<string, string> = {};
    for (const name of [
      "userDailyLimit",
      "userCooldownSeconds",
      "globalDailyLimit",
      "globalConcurrency",
    ]) {
      const value = field(c.request.form, name);
      if (value) values[name] = value;
    }
    if (!Object.keys(values).length)
      return failure(c, title, 400, "바꿀 값을 하나 이상 적어 주세요.");
    const back = `/admin/usage-policy${guildQuery(guild)}`;
    if (c.request.form.get("confirm") !== "1")
      return confirmPage(
        c,
        title,
        `서버 ${guild}의 사용 정책을 바꿀까요? (${Object.entries(values)
          .map(([name, value]) => `${name}=${value}`)
          .join(", ")})`,
        "/admin/usage-policy",
        { guild, ...values },
        back,
      );
    const outcome = await run(
      user,
      "usage_policy",
      { action: "설정", ...values },
      guild,
    );
    if (!outcome.ok) return failure(c, title, outcome.status, outcome.message);
    return done(c, title, outcome.result, back);
  });

  const serverConfig = async (c: WebRouteContext): Promise<WebResponse> => {
    const title = "서버 구성";
    const guild = selectedGuild(c);
    if (!guild) return guildPicker(c, title, "/admin/server-config", undefined);
    const format = c.request.query.get("format");
    if (format === "yaml" || format === "json") {
      const outcome = await run(
        c.account!,
        "server_config",
        { action: "내보내기", format },
        guild,
      );
      if (!outcome.ok)
        return failure(c, title, outcome.status, outcome.message);
      return view(
        c,
        title,
        `<pre>${h(outcome.result.messages.join("\n"))}</pre>`,
      );
    }
    return view(
      c,
      title,
      `<p class="muted">서버 ${h(guild)}</p>
<form method="post" action="/admin/server-config" class="card">${csrf(c)}${hidden({ guild })}
<p>변경 내용을 미리 보고, 확인한 뒤에 적용해요.</p>
<p><button class="primary" type="submit">미리보기</button></p></form>
<p><a href="/admin/server-config?guild=${h(guild)}&amp;format=yaml">YAML로 내보내기</a> · <a href="/admin/server-config?guild=${h(guild)}&amp;format=json">JSON으로 내보내기</a></p>`,
    );
  };

  const serverConfigPost = post("서버 구성", async (c, user) => {
    const title = "서버 구성";
    const guild = selectedGuild(c);
    if (!guild) return failure(c, title, 400, "서버를 골라 주세요.");
    const back = `/admin/server-config${guildQuery(guild)}`;
    const planId = field(c.request.form, "planId");
    if (!planId) {
      const outcome = await run(
        user,
        "server_config",
        { action: "미리보기" },
        guild,
      );
      if (!outcome.ok)
        return failure(c, title, outcome.status, outcome.message);
      const planned = outcome.result.data?.confirmationCustomId;
      const id =
        typeof planned === "string"
          ? planned.slice("server_config_apply:".length)
          : "";
      return view(
        c,
        `${title} 미리보기`,
        `<pre>${h(outcome.result.messages.join("\n"))}</pre>${
          SAFE_ID.test(id)
            ? `<form method="post" action="/admin/server-config" class="card">${csrf(c)}${hidden({ guild, planId: id, confirm: "1" })}<p>위 내용을 이 서버에 적용할까요?</p><p><button class="primary" type="submit">적용</button> <a class="btn" href="${h(back)}">취소</a></p></form>`
            : ""
        }`,
      );
    }
    if (c.request.form.get("confirm") !== "1" || !SAFE_ID.test(planId))
      return failure(c, title, 400, "미리보기를 확인한 뒤에 적용해 주세요.");
    const outcome = await run(
      user,
      "server_config",
      { action: "적용", planId },
      guild,
    );
    if (!outcome.ok) return failure(c, title, outcome.status, outcome.message);
    return done(c, title, outcome.result, back);
  });

  const webhooks = async (c: WebRouteContext): Promise<WebResponse> => {
    const title = "웹훅 연결";
    const guild = selectedGuild(c);
    if (!guild) return guildPicker(c, title, "/admin/webhooks", undefined);
    const id = c.request.query.get("id");
    if (id && SAFE_ID.test(id)) {
      const detail = await run(
        c.account!,
        "webhook",
        { action: "상세", id },
        guild,
      );
      if (!detail.ok) return failure(c, title, detail.status, detail.message);
      return view(
        c,
        title,
        `<pre>${h(detail.result.messages.join("\n"))}</pre><p><a class="btn" href="/admin/webhooks${guildQuery(guild)}">목록</a></p>`,
      );
    }
    const list = await run(c.account!, "webhook", { action: "목록" }, guild);
    if (!list.ok) return failure(c, title, list.status, list.message);
    // List lines are "<id> · <name> · <kind> · <state>"; each gets its own actions.
    const rows = list.result.messages
      .join("\n")
      .split("\n")
      .map((line) => line.split(" · "))
      .filter((parts) => parts.length === 4 && SAFE_ID.test(parts[0]!));
    const rowHtml = rows
      .map(([rowId, name, kind, state]) => {
        const active = state === "active";
        return `<li class="card"><p><strong>${h(name!)}</strong> <span class="muted">${h(kind!)} · ${h(state!)}</span></p><form method="post" action="/admin/webhooks">${csrf(c)}${hidden({ guild, id: rowId! })}<a class="btn" href="/admin/webhooks?guild=${h(guild)}&amp;id=${h(rowId!)}">상세</a> <button type="submit" name="action" value="test">테스트</button> <button type="submit" name="action" value="${active ? "stop" : "resume"}">${active ? "중지" : "재개"}</button></form></li>`;
      })
      .join("");
    return view(
      c,
      title,
      `<p class="muted">서버 ${h(guild)}</p>${rows.length ? `<ul class="plain">${rowHtml}</ul>` : '<p class="muted">등록된 웹훅이 없어요.</p>'}
<form method="post" action="/admin/webhooks" class="card">${csrf(c)}${hidden({ guild, action: "register" })}
<h2>새 연결</h2>
<label class="field">이름<input type="text" name="name" maxlength="100" required></label>
<label class="field">종류<select name="kind"><option value="GitHub 수신">GitHub 수신</option><option value="범용 수신">범용 수신</option><option value="Discord 발송">Discord 발송</option></select></label>
<label class="field">목적지 종류 (발송용)<select name="destinationKind"><option value="">없음</option><option value="채널">채널</option><option value="웹훅">웹훅</option></select></label>
<label class="field">목적지 ID<input type="text" name="destinationId" maxlength="200"></label>
<label class="field">이벤트 (쉼표로 구분)<input type="text" name="events" maxlength="200"></label>
<p class="muted">수신 URL과 비밀값은 등록 직후 한 번만 보여 줘요.</p>
<p><button class="primary" type="submit">등록</button></p></form>`,
    );
  };

  const webhooksPost = post("웹훅 연결", async (c, user) => {
    const title = "웹훅 연결";
    const guild = selectedGuild(c);
    if (!guild) return failure(c, title, 400, "서버를 골라 주세요.");
    const back = `/admin/webhooks${guildQuery(guild)}`;
    const form = c.request.form;
    const action = field(form, "action");
    if (action === "register") {
      const outcome = await run(
        user,
        "webhook",
        {
          action: "등록",
          name: field(form, "name"),
          kind: field(form, "kind"),
          destinationKind: field(form, "destinationKind"),
          destinationId: field(form, "destinationId"),
          events: field(form, "events"),
        },
        guild,
      );
      if (!outcome.ok)
        return failure(c, title, outcome.status, outcome.message);
      return done(c, title, outcome.result, back);
    }
    const id = field(form, "id");
    if (!SAFE_ID.test(id))
      return failure(c, title, 400, "웹훅을 확인하지 못했어요.");
    if (action === "stop" && form.get("confirm") !== "1")
      return confirmPage(
        c,
        title,
        "이 웹훅 연결을 중지할까요? 다시 재개하기 전까지 이벤트를 받지 않아요.",
        "/admin/webhooks",
        { guild, id, action },
        back,
      );
    const commandAction =
      action === "test"
        ? "테스트"
        : action === "stop"
          ? "중지"
          : action === "resume"
            ? "재개"
            : undefined;
    if (!commandAction)
      return failure(c, title, 400, "지원하지 않는 동작이에요.");
    const outcome = await run(
      user,
      "webhook",
      { action: commandAction, id },
      guild,
    );
    if (!outcome.ok) return failure(c, title, outcome.status, outcome.message);
    return done(c, title, outcome.result, back);
  });

  const get = (
    path: string,
    access: WebRoute["access"],
    handler: WebRoute["handler"],
  ): WebRoute => ({
    method: "GET",
    pattern: new RegExp(`^${path}$`),
    access,
    handler,
  });
  const postRoute = (
    path: string,
    access: WebRoute["access"],
    handler: WebRoute["handler"],
  ): WebRoute => ({
    method: "POST",
    pattern: new RegExp(`^${path}$`),
    access,
    handler,
  });

  return [
    get("/admin", "USER", index),
    get("/admin/subscribe", "ADMIN", async (c) => subscribeForm(c)),
    postRoute("/admin/subscribe", "ADMIN", subscribe),
    get("/admin/unsubscribe", "ADMIN", async (c) => unsubscribeForm(c)),
    postRoute("/admin/unsubscribe", "ADMIN", unsubscribe),
    get("/admin/sources", "ADMIN", textPage("수집원 상태", "sources")),
    get("/admin/deliveries", "ADMIN", textPage("발송내역", "deliveries")),
    get("/admin/status", "ADMIN", textPage("운영 상태", "status")),
    get("/admin/usage", "USER", textPage("AI 사용량", "usage", true)),
    get("/admin/usage-policy", "ADMIN", policy),
    postRoute("/admin/usage-policy", "ADMIN", policyUpdate),
    get("/admin/server-config", "SUPERADMIN", serverConfig),
    postRoute("/admin/server-config", "SUPERADMIN", serverConfigPost),
    get("/admin/webhooks", "SUPERADMIN", webhooks),
    postRoute("/admin/webhooks", "SUPERADMIN", webhooksPost),
  ];
}
