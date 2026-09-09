import type { ChatRoute } from "@rapi/contracts";

type Capability = {
  sideEffects: string;
  authority: "read" | "owner_explicit";
  evidence: string;
  fallback: string;
};
export const capabilities: Record<ChatRoute, Capability> = {
  answer: {
    sideEffects: "읽기 전용 Codex 응답",
    authority: "read",
    evidence: "답변은 실행 증거가 아님",
    fallback: "질문을 구체화",
  },
  execute: {
    sideEffects: "코드·서버·배포 변경",
    authority: "owner_explicit",
    evidence: "프로세스 종료·Git 관찰",
    fallback: "실패/중단 기록",
  },
  loop: {
    sideEffects: "최대 3회 변경 실행",
    authority: "owner_explicit",
    evidence: "시도별 종료·진전 관찰",
    fallback: "예산/장애/진전 없음에 정지",
  },
  status: {
    sideEffects: "없음",
    authority: "read",
    evidence: "저장된 실행 상태",
    fallback: "기록 없음",
  },
  cancel: {
    sideEffects: "소유자·채널 실행 프로세스 종료",
    authority: "owner_explicit",
    evidence: "프로세스 close 관찰",
    fallback: "종료 확인 불가 표시",
  },
  remember: {
    sideEffects: "기억 후보 생성 및 명시 요청 승인",
    authority: "owner_explicit",
    evidence: "출처·revision·digest",
    fallback: "저장하지 않음",
  },
  memory_list: {
    sideEffects: "없음",
    authority: "read",
    evidence: "현재 scope의 승인 기억",
    fallback: "기억 없음",
  },
  forget: {
    sideEffects: "기억 forgotten 전이",
    authority: "owner_explicit",
    evidence: "ID·revision",
    fallback: "대상 ID 요청",
  },
};

export function routeIntent(input: string): ChatRoute {
  const text = input.trim().replace(/^라피야[!,，]?\s*/, "");
  // Reference regions and meta-discussion never supply execution authority.
  if (/^(?:기억해줘|기억해 줘)\s*[:：]\s*\S/.test(text)) return "remember";
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(
      /`[^`]*(?:`|$)|"[^"\n]*(?:"|$)|“[^”]*(?:”|$)|'[^'\n]*(?:'|$)|‘[^’]*(?:’|$)/g,
      " ",
    )
    .replace(/^\s*>.*$/gm, " ")
    .trim();
  if (
    !plain ||
    /(?:하지\s*(?:마|말|않)|하지는\s*말|말고|금지|안\s*(?:해|하|고쳐|수정|배포|실행)|않아|않는|않도록|아니라|아닌|설명|예시|인용|문구|문장|뜻|방법|어떻게|만약|하면|되면|나면|경우|나중에|언젠가|아마|혹시|라고|라는|라면|한다면|할까|해도\s*돼|할\s*수\s*있)/.test(
      plain,
    )
  )
    return "answer";
  if (
    /^(?:지금\s*|일단\s*|잠깐\s*)?(?:멈춰(?:줘)?|중단해(?:줘)?|취소해(?:줘)?)[.!\s]*$/.test(
      plain,
    )
  )
    return "cancel";
  if (/(?:기억|메모리).*(?:목록|보여줘|알려줘)|^뭘 기억/.test(plain))
    return "memory_list";
  if (
    /^(?:기억\s+)?(?:[a-f0-9-]{36}|최근(?:\s*기억)?|방금(?:\s*기억)?)\s*(?:을\s*|를\s*)?(?:잊어줘|삭제해줘|잊어 줘)[.!\s]*$/i.test(
      plain,
    )
  )
    return "forget";
  if (
    /(?:지금|현재).*(?:뭐\s*하|작업|진행)|최근\s*작업|작업\s*상태|어디까지/.test(
      plain,
    )
  )
    return "status";
  if (
    /(?:끝날|될)\s*때까지/.test(plain) &&
    /(?:해줘|해\s*줘|고쳐줘|진행해|마무리해|반복해|해라|해)[.!\s]*$/.test(plain)
  )
    return "loop";
  if (
    /(?:고쳐|수정해|변경해|배포해|실행해|설치해|삭제해|만들어|구현해|추가해|업데이트해|돌려|재시작해|커밋해|푸시해|적용해|진행해|처리해)(?:줘|\s*줘|주세요|\s*주세요|라)?[.!\s]*$/.test(
      plain,
    )
  )
    return "execute";
  return "answer";
}
