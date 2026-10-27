import { CARD_COLOR, discordEmbed, type DiscordCard } from "@rapi/core";

/** The pinned guide in #라피-도움말: what Rapi does and where to start. */
export function helpCards(): DiscordCard[] {
  return [
    {
      title: "라피 사용 안내",
      description:
        "라피는 AI·개발 소식을 모아 요약해 주고, 질문에 답하고, 일정을 챙겨 주는 도우미입니다.\n아래 세 가지만 알면 바로 쓸 수 있어요.",
      color: CARD_COLOR.info,
      fields: [
        {
          name: "1. 질문하기",
          value:
            "`#라피-질문`에 그냥 물어보세요. 수집한 글을 근거로 답하고, 근거가 약하면 모른다고 말합니다.",
        },
        {
          name: "2. 소식 받아보기",
          value:
            "`/구독 이름:… 키워드:… 주기:매일` 으로 관심 키워드의 알림을 만들고, `/구독해제` 로 끕니다.\n`/브리핑` 은 최근 24시간 소식을 바로 보여 줍니다. `/검색 검색어:…` 로 수집한 글을 찾을 수 있어요.",
        },
        {
          name: "3. 일정 챙기기",
          value:
            '`/일정 추가` 에 "금요일 오후 3시 면담"처럼 적으면 등록하고, `/일정 목록` 으로 앞으로 30일을 봅니다.',
        },
        {
          name: "채널 안내",
          value:
            "`#ai-블로그` 공식 블로그 소식 · `#무료-토큰` 무료 크레딧·티어 소식 · `#프로젝트-소식` `#세팅-추천레포` 개발자 큐레이션",
        },
        {
          name: "내 정보",
          value:
            "`/사용량` 으로 내 AI 사용량을 보고, `/데이터삭제` 로 라피가 보관한 내 정보의 삭제를 요청할 수 있어요.",
        },
      ],
      footer: "막히면 #라피-질문 에 상황을 적어 주세요.",
    },
  ];
}

export function helpMessageBody(): string {
  return JSON.stringify({
    embeds: helpCards().map((card) => discordEmbed(card)),
    allowed_mentions: { parse: [] },
  });
}
