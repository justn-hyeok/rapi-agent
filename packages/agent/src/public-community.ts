import { redactChat } from "@rapi/contracts";
import { BUDGET_REPLY } from "@rapi/core";
import type { PostgresStore } from "@rapi/db";
import { createHash } from "node:crypto";
import type { ChatbotPlan, ChatbotReply, ChatbotService } from "./chatbot.js";

export interface PublicAnswerTransport {
  answer(
    prompt: string,
    onStarted: () => Promise<void> | void,
    options?: { feature?: "archive_qa" | "public_qa" },
  ): Promise<{
    started: boolean;
    ok: boolean;
    output: string;
    reason: "exit" | "timeout" | "cancel" | "spawn_error" | "budget";
  }>;
}

export class PublicCommunityService {
  constructor(
    readonly store: PostgresStore,
    readonly transport: PublicAnswerTransport,
    readonly enabled = true,
    /** Set when CHATBOT_ENABLED: archive Q&A replaces the free-form public answer. */
    readonly chatbot?: ChatbotService,
  ) {}

  async answer(input: {
    guildId: string;
    userId: string;
    requestId: string;
    tier: "user" | "staff";
    text: string;
    mode?: "question" | "brief";
    channelId?: string;
  }): Promise<string | undefined> {
    return (await this.converse(input))?.content;
  }

  /** Like `answer`, but a chatbot reply may carry buttons (subscription confirm). */
  async converse(input: {
    guildId: string;
    userId: string;
    requestId: string;
    tier: "user" | "staff";
    text: string;
    mode?: "question" | "brief";
    channelId?: string;
  }): Promise<ChatbotReply | undefined> {
    const say = (content: string): ChatbotReply => ({ content });
    if (!this.enabled)
      return say(
        "라피 공개 질문 기능을 준비 중입니다. 잠시 후 다시 이용해주세요.",
      );
    let plan: ChatbotPlan | undefined;
    // Thread context is scoped to one channel; a Discord thread is its own channel.
    const chat = {
      userId: input.userId,
      text: input.text,
      ...(input.channelId
        ? { scopeKey: `discord:${input.guildId}:${input.channelId}` }
        : {}),
    };
    if (this.chatbot && input.mode !== "brief") {
      plan = await this.chatbot.plan(chat);
      if (plan.kind === "reply") {
        await this.chatbot.remember(chat, plan.reply.content);
        return plan.reply;
      }
    }
    const reservation = await this.store.reserveAiUsage({
      guildId: input.guildId,
      userId: input.userId,
      requestId: input.requestId,
      tier: input.tier,
      requestDigest: createHash("sha256").update(input.text).digest("hex"),
      model: "gpt-5.6-luna",
    });
    if (reservation.duplicate) return undefined;
    if (!reservation.accepted) {
      if (reservation.reason === "cooldown")
        return say(
          `쿨다운 중입니다. ${reservation.retryAt?.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" }) ?? "잠시 후"} 다시 시도해주세요.`,
        );
      if (reservation.reason === "concurrency")
        return say(
          "현재 라피 질문 처리량이 가득 찼습니다. 잠시 후 다시 시도해주세요.",
        );
      return say(
        `오늘의 AI 사용 한도에 도달했습니다. ${reservation.resetAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}에 초기화됩니다.`,
      );
    }
    try {
      const feedContext =
        input.mode === "brief"
          ? await this.store.recentPublicItems(
              20,
              new Date(Date.now() - 86_400_000),
            )
          : [];
      const prompt =
        plan?.kind === "model"
          ? plan.prompt
          : [
              "너는 Discord 커뮤니티의 공개 정보 비서 라피다.",
              "한국어로 간결하게 답하고 최신 정보가 필요한 질문은 실시간 웹 검색을 우선 사용한다.",
              "사실 주장에는 확인한 공개 출처 링크를 붙인다.",
              "서버 파일, 환경변수, 데이터베이스, 비공개 대화, 관리자 기억을 조회하거나 추측하지 않는다.",
              "코드·서버·외부 서비스 변경을 수행하지 말고 방법만 설명한다.",
              input.mode === "brief"
                ? "아래 공개 피드 후보를 확인하고 필요하면 웹 검색으로 최신성을 보완해 24시간 기술 브리핑을 작성한다."
                : "사용자의 공개 정보 질문에 답한다.",
              ...(feedContext.length
                ? [
                    "공개 피드 후보(JSON):",
                    JSON.stringify(feedContext).slice(0, 6_000),
                  ]
                : []),
              "사용자 요청:",
              input.text.slice(0, 4_000),
            ].join("\n\n");
      const result = await this.transport.answer(
        prompt,
        async () => {
          await this.store.markAiUsageStarted(input.requestId);
        },
        plan?.kind === "model" ? { feature: plan.feature } : undefined,
      );
      if (!result.started && !result.ok) {
        const released = await this.store.releaseAiUsage(input.requestId);
        if (released)
          return say(
            "공개 질문 실행기를 사용할 수 없습니다. 잠시 후 다시 시도해주세요. 사용량은 차감되지 않았습니다.",
          );
      }
      await this.store.finishAiUsage(
        input.requestId,
        result.ok ? "succeeded" : "failed",
        result.ok ? undefined : result.reason,
      );
      if (result.reason === "budget" && !result.ok) return say(BUDGET_REPLY);
      if (!result.ok)
        return say("공개 질문 처리에 실패했습니다. 잠시 후 다시 시도해주세요.");
      const text = redactChat(result.output).slice(0, 6_000);
      const reply = plan?.kind === "model" ? plan.finalize(text) : say(text);
      if (this.chatbot && plan)
        await this.chatbot.remember(chat, reply.content);
      return reply;
    } catch {
      const released = await this.store.releaseAiUsage(input.requestId);
      if (!released)
        await this.store.finishAiUsage(input.requestId, "failed", "transport");
      return say(
        "공개 질문 실행기를 사용할 수 없습니다. 운영 상태를 확인해주세요.",
      );
    }
  }
}
