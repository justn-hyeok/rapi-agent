import type { ButtonOutcome } from "./button-outcome.js";

export interface GuildDecisionPorts {
  /** Records the decision; false when the request was already decided or is unknown. */
  decide(
    guildId: string,
    status: "allowed" | "rejected",
    actorId: string,
  ): Promise<boolean>;
  /** Drops the cached approved-guild list. */
  invalidate(): void;
  /** Makes Rapi leave the guild; false when Discord refused. */
  leave(guildId: string): Promise<boolean>;
  registerCommands(guildId: string): Promise<void>;
  /** Web page for server configuration; absent when the web is off. */
  serverConfigUrl?: string | undefined;
}

export const GUILD_DECISION_PREFIXES = ["guild_allow:", "guild_reject:"];

export function isGuildDecision(customId: string): boolean {
  return GUILD_DECISION_PREFIXES.some((prefix) => customId.startsWith(prefix));
}

/** [허용] / [거절] pressed on the owner's approval request; the caller checks SUPERADMIN. */
export async function decideGuildButton(
  ports: GuildDecisionPorts,
  customId: string,
  actorId: string,
): Promise<ButtonOutcome> {
  const allow = customId.startsWith("guild_allow:");
  const guildId = customId.slice(customId.indexOf(":") + 1);
  if (!/^\d+$/.test(guildId)) throw new Error("알 수 없는 버튼입니다.");
  const decided = await ports.decide(
    guildId,
    allow ? "allowed" : "rejected",
    actorId,
  );
  ports.invalidate();
  if (!decided) return { result: "이미 처리했거나 요청이 없는 서버입니다." };
  if (!allow)
    return {
      result: (await ports.leave(guildId))
        ? "서버를 거절하고 라피가 나갔습니다."
        : "서버를 거절했지만 라피가 나가지 못했습니다. 직접 내보내 주세요.",
    };
  const next = ports.serverConfigUrl
    ? `그 서버에서 \`/서버구성\`을 실행하거나 ${ports.serverConfigUrl} 에서 피드 채널을 만들어 주세요.`
    : "그 서버에서 `/서버구성`을 실행해 피드 채널을 만들어 주세요.";
  try {
    await ports.registerCommands(guildId);
  } catch {
    return {
      result: `서버를 허용했습니다. slash 명령 등록은 실패했으니 나중에 다시 등록해 주세요. 다음 단계: ${next}`,
    };
  }
  return {
    result: `서버를 허용했습니다. slash 명령도 등록했습니다. 다음 단계: ${next}`,
  };
}
