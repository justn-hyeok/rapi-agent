import pg from "pg";
import {
  requestDeletion,
  confirmDeletion,
  deletionStatus,
} from "./privacy-lifecycle.mjs";
export async function executePrivacyCommand(
  identity,
  options,
  level,
  key,
  connectionString,
) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  try {
    await client.connect();
    const common = {
      guildId: identity.guildId,
      userId: identity.userId,
      key,
      admin: level === "superadmin",
    };
    if (!common.guildId) throw new Error("guild_required");
    if (options.action === "요청") {
      const kind = options.kind ?? "user";
      const result = await requestDeletion(client, {
        ...common,
        kind,
        target: options.target,
        admin: level === "superadmin",
      });
      return {
        messages: [
          `삭제 미리보기 ${result.id}\n대상: ${kind === "user" ? "내 대화·기억·구독·작업·사용 기록" : kind === "item" ? "수집 항목과 연결된 브리핑" : "수집원과 연결된 항목·브리핑"}\n대상 건수: ${Object.entries(
            result.counts,
          )
            .map(([name, n]) => `${name} ${n}`)
            .join(
              ", ",
            )}\n확정 전에는 삭제하지 않습니다. 24시간 안에 /데이터삭제 확정 요청ID:${result.id} 로 실행하세요. 기존 백업은 만료될 때까지 추적합니다.${result.ambiguous ? "\n이전 답변의 소유 관계가 불명확해 확인이 필요합니다." : ""}`,
        ],
      };
    }
    const id = options.deletionId;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("invalid_request");
    if (options.action === "확정") {
      await confirmDeletion(client, { ...common, id });
      return {
        messages: [
          `삭제 요청 ${id}를 확정했습니다. 진행 중인 작업은 종료 후 처리하며, /데이터삭제 상태 요청ID:${id} 로 확인할 수 있습니다.`,
        ],
      };
    }
    const status = await deletionStatus(client, { ...common, id });
    const labels = {
      preview: "확정 대기",
      confirmed: "처리 대기",
      blocked: "진행 중 작업·파일 확인 대기",
      waiting_backups: "DB·파일 처리 완료, 기존 백업 만료 대기",
      completed: "삭제 및 백업 만료 확인 완료",
    };
    return {
      messages: [
        `${id}: ${labels[status.state] ?? status.state}${status.backupDeadline ? `\n백업 만료 예정: ${new Date(status.backupDeadline).toISOString()}` : ""}${status.error ? `\n확인 항목: ${status.error}` : ""}`,
      ],
    };
  } catch (error) {
    const messages = {
      owner_permission_required:
        "항목·수집원 삭제는 소유자만 요청할 수 있습니다.",
      request_not_found: "본인 요청 ID와 서버를 확인해주세요.",
      confirmation_expired_or_used:
        "확정 기한이 지났거나 이미 확정했습니다. 상태를 확인하거나 새 요청을 만드세요.",
      target_not_found: "삭제 대상을 찾지 못했습니다.",
      privacy_key_missing: "개인정보 정리 기능이 연결되지 않았습니다.",
    };
    throw new Error(
      messages[error.message] ??
        "삭제 요청 처리에 실패했습니다. 대상·요청 ID와 서버 상태를 확인해주세요.",
      { cause: error },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
