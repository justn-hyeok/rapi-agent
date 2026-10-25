import type {
  ChatRun,
  ChatScope,
  RunEvidence,
  RunPhase,
} from "@rapi/contracts";
import { textDigest } from "@rapi/contracts";
import type { ChatOpsStore } from "@rapi/db";
import type { Executor, ExecuteInput } from "../../apps/chat/src/executor.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

export function fakes() {
  const claims: unknown[][] = [];
  const runs = new Map<string, ChatRun>();
  const store = {
    db: {
      recentChatMessages: async () => [],
      appendChatMessage: async () => undefined,
    },
    claim: async (
      scope: ChatScope,
      message: string,
      text: string,
      route: string,
      model: string,
    ) => {
      claims.push([scope, message, text, route, model]);
      if (route !== "execute" && route !== "loop") return { inserted: true };
      const run = {
        id: RUN_ID,
        guild_id: scope.guild,
        channel_id: scope.channel,
        owner_id: scope.owner,
        message_id: message,
        route,
        phase: "prepared",
        model,
        task_digest: textDigest(text),
        created_at: new Date(),
        updated_at: new Date(),
        evidence: {},
      } as ChatRun;
      runs.set(run.id, run);
      return { inserted: true, run };
    },
    transition: async (
      id: string,
      _expected: RunPhase,
      next: RunPhase,
      evidence: RunEvidence = {},
    ) => {
      const run = { ...runs.get(id)!, phase: next, evidence };
      runs.set(id, run);
      return run;
    },
    get: async (id: string) => runs.get(id)!,
    recent: async () => [...runs.values()],
    memories: async () => [],
  } as unknown as ChatOpsStore;
  const prompts: ExecuteInput[] = [];
  const executor: Executor = {
    observe: async () => undefined,
    verify: async () => undefined,
    run: async (input) => {
      prompts.push(input);
      return {
        exitCode: 0,
        signal: null,
        reason: "exit",
        output: "끝났습니다",
        blocked: false,
      };
    },
  };
  const sent: Array<[string, string]> = [];
  const send = async (channel: string, text: string) => {
    sent.push([channel, text]);
  };
  return { store, executor, sent, send, claims, prompts };
}
