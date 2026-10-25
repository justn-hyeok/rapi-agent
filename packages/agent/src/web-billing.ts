import {
  escapeHtml as h,
  formatBillingDate,
  formatKrw,
  isBillingOrderId,
  planPurchasable,
  type BillingPlan,
} from "@rapi/core";
import type { BillingService } from "./billing-service.js";
import type { WebNavLink, WebPageScript, WebResponse } from "./web-layout.js";
import { messagePage } from "./web-layout.js";
import type { WebAccount, WebRoute, WebRouteContext } from "./web-portal.js";

const TOSS_SDK = "https://js.tosspayments.com/v2/standard";
const TOSS_ALLOW = {
  frame: ["https://*.tosspayments.com"],
  connect: ["https://*.tosspayments.com"],
  img: ["https://*.tosspayments.com", "https://static.toss.im"],
};

export const WEB_BILLING_NAV: WebNavLink[] = [
  { href: "/billing", label: "요금제" },
  { href: "/admin/billing", label: "결제", role: "SUPERADMIN" },
];

export interface WebBillingOptions {
  service: BillingService;
  baseUrl: string;
  clientKey: string;
  /** `BILLING_LIVE`; false shows the "테스트 결제" badge. */
  live: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "결제 대기",
  paid: "결제 완료",
  failed: "실패",
  canceled: "환불됨",
  expired: "만료",
};

/** JSON for an inline script: `<` is escaped so no value can close the tag. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function planCard(plan: BillingPlan, loggedIn: boolean): string {
  const buyable = planPurchasable(plan);
  const action = !buyable
    ? '<p><span class="tag">준비 중</span></p>'
    : loggedIn
      ? `<p><a class="btn primary" href="/billing/checkout?plan=${h(plan.id)}">구매하기</a></p>`
      : '<p><a class="btn primary" href="/auth/discord/login">로그인하고 구매하기</a></p>';
  return `<article class="card"><h2>${h(plan.name)}</h2><p>${h(plan.description)}</p><p><strong>${buyable ? formatKrw(plan.priceKrw) : "준비 중"}</strong> <span class="muted">· ${plan.periodDays}일 이용권, 자동 갱신 없음</span></p>${action}</article>`;
}

export function webBillingRoutes(options: WebBillingOptions): WebRoute[] {
  const { service } = options;
  const base = options.baseUrl.replace(/\/+$/, "");
  const badge = options.live
    ? ""
    : '<p class="note"><strong>테스트 결제</strong> — 실제로 돈이 빠져나가지 않아요.</p>';

  const message = (
    c: WebRouteContext,
    status: number,
    title: string,
    text: string,
    extra = "",
  ): WebResponse =>
    c.portal.page(c.account, {
      title,
      status,
      body: `<h1>${h(title)}</h1>${badge}<p>${h(text)}</p>${extra}`,
    });

  const retry = '<p><a class="btn" href="/billing">요금제로 돌아가기</a></p>';

  async function list(c: WebRouteContext): Promise<WebResponse> {
    const entitlement = c.account
      ? await service.entitlement(c.account.userId)
      : undefined;
    const current = entitlement
      ? `<p class="card">현재 이용권: <strong>${h(service.planName(entitlement.planId))}</strong> (${formatBillingDate(entitlement.validUntil)}까지). 다시 구매하면 끝나는 날부터 이어져요.</p>`
      : "";
    return c.portal.page(c.account, {
      title: "요금제",
      body: `<h1>요금제</h1>${badge}${current}${service
        .plans()
        .map((plan) => planCard(plan, c.account !== undefined))
        .join(
          "",
        )}<p class="muted">기간권은 한 번 결제하면 정해진 기간 동안 쓰고, 저절로 갱신되지 않아요.</p>`,
    });
  }

  async function checkout(c: WebRouteContext): Promise<WebResponse> {
    const user = c.account!;
    const result = await service.checkout(
      user.userId,
      c.request.query.get("plan") ?? "",
    );
    if (result.kind === "unknown_plan")
      return message(
        c,
        404,
        "없는 요금제예요",
        "요금제를 다시 골라 주세요.",
        retry,
      );
    if (result.kind === "not_purchasable")
      return message(
        c,
        409,
        "준비 중인 요금제예요",
        "아직 구매할 수 없어요.",
        retry,
      );
    const { order, plan } = result;
    const script: WebPageScript = {
      srcs: [TOSS_SDK],
      allow: TOSS_ALLOW,
      inline: `(async()=>{const d=${scriptJson({
        clientKey: options.clientKey,
        customerKey: service.customerKey(user.userId),
        orderId: order.orderId,
        orderName: plan.name,
        amount: order.amountKrw,
        successUrl: `${base}/billing/success`,
        failUrl: `${base}/billing/fail`,
      })};const status=document.getElementById("pay-status");const button=document.getElementById("pay");try{const widgets=TossPayments(d.clientKey).widgets({customerKey:d.customerKey});await widgets.setAmount({currency:"KRW",value:d.amount});await Promise.all([widgets.renderPaymentMethods({selector:"#payment-method",variantKey:"DEFAULT"}),widgets.renderAgreement({selector:"#agreement",variantKey:"AGREEMENT"})]);button.disabled=false;button.addEventListener("click",async()=>{button.disabled=true;try{await widgets.requestPayment({orderId:d.orderId,orderName:d.orderName,successUrl:d.successUrl,failUrl:d.failUrl})}catch(e){button.disabled=false;status.textContent="결제를 시작하지 못했어요. 다시 시도해 주세요."}})}catch(e){status.textContent="결제창을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요."}})();`,
    };
    return c.portal.page(c.account, {
      title: "결제",
      script,
      body: `<h1>${h(plan.name)} 결제</h1>${badge}<p>${formatKrw(order.amountKrw)} · ${plan.periodDays}일 이용권</p><div id="payment-method"></div><div id="agreement"></div><p><button class="primary" id="pay" type="button" disabled>${formatKrw(order.amountKrw)} 결제하기</button></p><p class="muted" id="pay-status" role="status"></p><p class="muted">자동으로 갱신되지 않아요. 결제 기록은 법에 따라 보관돼요.</p>`,
    });
  }

  async function success(c: WebRouteContext): Promise<WebResponse> {
    const user = c.account!;
    const query = c.request.query;
    const orderId = query.get("orderId");
    const paymentKey = query.get("paymentKey") ?? "";
    const rawAmount = query.get("amount") ?? "";
    if (
      !isBillingOrderId(orderId) ||
      !/^[\w-]{1,200}$/.test(paymentKey) ||
      !/^\d{1,9}$/.test(rawAmount)
    )
      return message(
        c,
        400,
        "결제 정보를 확인하지 못했어요",
        "처음부터 다시 시도해 주세요.",
        retry,
      );
    const result = await service.complete({
      userId: user.userId,
      orderId,
      paymentKey,
      amount: Number(rawAmount),
    });
    switch (result.kind) {
      case "paid":
        return message(
          c,
          200,
          "결제가 끝났어요",
          result.validUntil
            ? `${formatBillingDate(result.validUntil)}까지 이용할 수 있어요.`
            : "이용권이 적용됐어요.",
          '<p><a class="btn primary" href="/me">내 구독으로</a></p>',
        );
      case "not_found":
        return message(
          c,
          404,
          "주문을 찾지 못했어요",
          "내 주문이 아니거나 없는 주문이에요.",
          retry,
        );
      case "closed":
        return message(
          c,
          409,
          "이미 닫힌 주문이에요",
          `이 주문은 "${STATUS_LABEL[result.order.status] ?? result.order.status}" 상태라 다시 확인할 수 없어요. 새로 결제해 주세요.`,
          retry,
        );
      case "tampered":
        return message(
          c,
          400,
          "결제 금액이 맞지 않아요",
          "안전을 위해 결제를 확정하지 않았어요. 처음부터 다시 시도해 주세요.",
          retry,
        );
      case "failed":
        return message(
          c,
          402,
          "결제를 확정하지 못했어요",
          "카드사 또는 토스에서 결제를 거절했어요. 다시 시도해 주세요.",
          retry,
        );
      case "waiting":
        return message(
          c,
          202,
          "결제 확인 중이에요",
          "토스의 확인이 아직 오지 않았어요. 곧 이용권이 적용돼요. 몇 분 뒤에도 그대로면 운영자에게 알려 주세요. 다시 결제하지 마세요.",
          '<p><a class="btn" href="/me">내 구독으로</a></p>',
        );
    }
  }

  async function fail(c: WebRouteContext): Promise<WebResponse> {
    const user = c.account!;
    const orderId = c.request.query.get("orderId");
    if (isBillingOrderId(orderId))
      await service.fail({
        userId: user.userId,
        orderId,
        code: (c.request.query.get("code") ?? "UNKNOWN").slice(0, 80),
      });
    // Toss's message is user-facing Korean text, but it is shown escaped and only as a hint.
    const reason = (c.request.query.get("message") ?? "").slice(0, 200);
    return message(
      c,
      200,
      "결제가 끝나지 않았어요",
      reason ? `사유: ${reason}` : "결제가 취소되었거나 실패했어요.",
      '<p><a class="btn primary" href="/billing">다시 시도하기</a></p>',
    );
  }

  async function webhook(c: WebRouteContext): Promise<WebResponse> {
    let paymentKey: unknown;
    try {
      const body = JSON.parse(c.request.body ?? "") as {
        data?: { paymentKey?: unknown };
      };
      paymentKey = body.data?.paymentKey;
    } catch {
      return {
        status: 400,
        headers: { "cache-control": "no-store" },
        body: "",
      };
    }
    // The body is only a hint; anything but a plain payment key is ignored.
    if (typeof paymentKey !== "string" || !/^[\w-]{1,200}$/.test(paymentKey))
      return {
        status: 200,
        headers: { "cache-control": "no-store" },
        body: "",
      };
    try {
      await service.reconcile(paymentKey);
    } catch {
      // Toss or the store failed; a 5xx makes Toss retry the delivery.
      return {
        status: 503,
        headers: { "cache-control": "no-store" },
        body: "",
      };
    }
    return { status: 200, headers: { "cache-control": "no-store" }, body: "" };
  }

  async function admin(
    c: WebRouteContext,
    notice?: string,
  ): Promise<WebResponse> {
    const orders = await service.recentOrders(50);
    const rows = orders
      .map(
        (order) =>
          `<li class="card"><p><strong>${h(service.planName(order.planId))}</strong> · ${formatKrw(order.amountKrw)} · ${h(STATUS_LABEL[order.status] ?? order.status)}<br><span class="muted">${h(order.orderId)} · ${h(order.userId)} · ${h(order.createdAt.toISOString())}${order.method ? ` · ${h(order.method)}` : ""}${order.cancelReason ? ` · ${h(order.cancelReason)}` : ""}</span></p>${
            order.status === "paid"
              ? `<form method="post" action="/admin/billing"><input type="hidden" name="csrf" value="${h(c.account!.csrf)}"><input type="hidden" name="orderId" value="${h(order.orderId)}"><button type="submit" name="action" value="refund">환불</button></form>`
              : ""
          }</li>`,
      )
      .join("");
    return c.portal.page(c.account, {
      title: "결제 관리",
      body: `<p><a href="/admin">← 관리</a></p><h1>결제 관리</h1>${badge}${notice ? `<p class="note">${h(notice)}</p>` : ""}${rows ? `<ul class="plain">${rows}</ul>` : '<p class="muted">주문이 없어요.</p>'}`,
    });
  }

  async function adminPost(c: WebRouteContext): Promise<WebResponse> {
    const user: WebAccount = c.account!;
    if (!c.portal.verifyCsrf(user, c.request))
      return messagePage(
        403,
        "요청을 확인하지 못했어요",
        "페이지를 새로 열고 다시 시도해 주세요.",
        c.portal.nav(user),
      );
    const form = c.request.form;
    const orderId = form.get("orderId");
    if (form.get("action") !== "refund" || !isBillingOrderId(orderId))
      return admin(c, "요청을 확인하지 못했어요.");
    if (form.get("confirm") !== "1")
      return c.portal.page(user, {
        title: "환불 확인",
        body: `<p><a href="/admin/billing">← 결제 관리</a></p><h1>환불할까요?</h1><form method="post" action="/admin/billing" class="card"><p>주문 ${h(orderId)}을 전액 환불해요. 이용 기간도 그만큼 줄어요. 되돌릴 수 없어요.</p><input type="hidden" name="csrf" value="${h(user.csrf)}"><input type="hidden" name="orderId" value="${h(orderId)}"><input type="hidden" name="action" value="refund"><input type="hidden" name="confirm" value="1"><p><button class="primary" type="submit">환불하기</button> <a class="btn" href="/admin/billing">취소</a></p></form>`,
      });
    const result = await service.refund(orderId, "관리자 환불");
    const text = {
      refunded: "환불했어요.",
      not_found: "없는 주문이에요.",
      not_paid: "결제 완료 상태의 주문만 환불할 수 있어요.",
      failed: `환불하지 못했어요. ${result.kind === "failed" ? result.message : ""}`,
    }[result.kind];
    return admin(c, text);
  }

  return [
    { method: "GET", pattern: /^\/billing$/, access: "public", handler: list },
    {
      method: "GET",
      pattern: /^\/billing\/checkout$/,
      access: "USER",
      handler: checkout,
    },
    {
      method: "GET",
      pattern: /^\/billing\/success$/,
      access: "USER",
      handler: success,
    },
    {
      method: "GET",
      pattern: /^\/billing\/fail$/,
      access: "USER",
      handler: fail,
    },
    {
      method: "POST",
      pattern: /^\/billing\/webhook\/toss$/,
      access: "public",
      handler: webhook,
    },
    {
      method: "GET",
      pattern: /^\/admin\/billing$/,
      access: "SUPERADMIN",
      handler: (c) => admin(c),
    },
    {
      method: "POST",
      pattern: /^\/admin\/billing$/,
      access: "SUPERADMIN",
      handler: adminPost,
    },
  ];
}
