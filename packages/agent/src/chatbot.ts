import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { redactChat } from "@rapi/contracts";
import {
  ARCHIVE_TOP_K,
  SMALL_TALK_REPLY,
  buildExplainPrompt,
  buildGroundedPrompt,
  classifyChatbotIntent,
  finalizeGroundedAnswer,
  formatNoEvidence,
  formatPostList,
  learnerItemFromPost,
  selectContext,
  selectLearnerItems,
  splitEvidence,
  stripLinks,
  type ArchiveDocument,
  type ArchiveHit,
  type ChatTurn,
  type LearnerCadence,
} from "@rapi/core";
import type { PostgresStore } from "@rapi/db";
import { LEARNER_FEEDS } from "./learner-experiment.js";

export interface ChatbotReply {
  content: string;
  components?: unknown[];
}

/**
 * What to do with one message. A "model" plan only asks for text; nothing in a
 * plan can call a tool, change a subscription or open a link by itself.
 */
export type ChatbotPlan =
  | { kind: "reply"; reply: ChatbotReply }
  | {
      kind: "model";
      feature: "archive_qa" | "public_qa";
      prompt: string;
      finalize(output: string): ChatbotReply;
    };

export interface ChatbotArchive {
  searchArchive(query: string, limit?: number): Promise<ArchiveHit[]>;
  recentTurns(scopeKey: string, userId: string): Promise<ChatTurn[]>;
  appendTurns(
    scopeKey: string,
    userId: string,
    turns: ChatTurn[],
  ): Promise<void>;
  learnerSubscription(
    userId: string,
  ): Promise<{ cadence: LearnerCadence; active: boolean } | null>;
}

export type ChatbotLearner = Pick<
  PostgresStore,
  "learnerSetCadence" | "learnerOptOut" | "learnerCandidatePosts"
>;

export interface RepoOverview {
  description: string;
  readme: string;
  entries: Array<{ name: string; type: string }>;
}

export type RepoReader = (
  owner: string,
  repo: string,
) => Promise<RepoOverview | null>;

const CADENCE_LABEL: Record<LearnerCadence, string> = {
  daily: "매일",
  weekly: "매주",
};
const button = (label: string, customId: string, style: number) => ({
  type: 2,
  style,
  label,
  custom_id: customId,
});

export const CHATBOT_SUBSCRIPTION_PREFIX = "chatbot_sub:";

/** The id names the one user who may press it; the handler checks it again. */
export function chatbotSubscriptionId(
  userId: string,
  action: LearnerCadence | "stop" | "cancel",
): string {
  return `${CHATBOT_SUBSCRIPTION_PREFIX}${userId}:${action}`;
}

export class ChatbotService {
  constructor(
    private readonly archive: ChatbotArchive,
    private readonly learner: ChatbotLearner,
    private readonly options: {
      l2Enabled: boolean;
      readRepo?: RepoReader;
      now?: () => Date;
    },
  ) {}

  async plan(input: {
    userId: string;
    scopeKey?: string;
    text: string;
  }): Promise<ChatbotPlan> {
    const intent = classifyChatbotIntent(input.text);
    const reply = (content: string, components?: unknown[]): ChatbotPlan => ({
      kind: "reply",
      reply: components ? { content, components } : { content },
    });
    switch (intent.kind) {
      case "small_talk":
        return reply(SMALL_TALK_REPLY);
      case "track_preview":
        return reply(await this.trackPreview());
      case "find_posts": {
        const hits = await this.archive.searchArchive(
          intent.query,
          ARCHIVE_TOP_K,
        );
        const { relevant, nearest } = splitEvidence(hits);
        return reply(formatPostList(intent.query, relevant, nearest));
      }
      case "subscription_cadence":
      case "subscription_stop":
        return this.subscriptionPlan(input.userId, intent);
      case "explain_error":
      case "repo_explain":
        return this.explainPlan(input, intent);
      case "question":
        return this.groundedPlan(input);
    }
  }

  /** Keeps the last exchange of this thread for 24 hours (the store sets the expiry). */
  async remember(
    input: { userId: string; scopeKey?: string; text: string },
    answer: string,
  ): Promise<void> {
    if (!input.scopeKey) return;
    await this.archive.appendTurns(input.scopeKey, input.userId, [
      { role: "user", content: redactChat(input.text) },
      { role: "assistant", content: redactChat(answer) },
    ]);
  }

  private async history(input: {
    userId: string;
    scopeKey?: string;
  }): Promise<ChatTurn[]> {
    if (!input.scopeKey) return [];
    return selectContext(
      await this.archive.recentTurns(input.scopeKey, input.userId),
    );
  }

  private async trackPreview(): Promise<string> {
    const now = (this.options.now ?? (() => new Date()))();
    const posts = await this.learner.learnerCandidatePosts(
      new Date(now.getTime() - 7 * 86_400_000),
      LEARNER_FEEDS,
    );
    const items = selectLearnerItems(
      posts.flatMap((post) => {
        const item = learnerItemFromPost(post);
        return item ? [item] : [];
      }),
    );
    if (!items.length)
      return "이번 주에 학습자 소식 후보로 모인 글이 아직 없어요. 발송 전에는 운영자가 확인하고, 후보는 바뀔 수 있어요.";
    return [
      "이번 주 학습자 소식 후보예요. 발송 전에 운영자가 확인하고 바뀔 수 있어요.",
      ...items.map(
        (item, index) => `${index + 1}. [${item.title}](${item.url})`,
      ),
    ].join("\n");
  }

  private async subscriptionPlan(
    userId: string,
    intent:
      | { kind: "subscription_cadence"; cadence: LearnerCadence }
      | { kind: "subscription_stop" },
  ): Promise<ChatbotPlan> {
    const current = await this.archive.learnerSubscription(userId);
    if (!current?.active)
      return {
        kind: "reply",
        reply: {
          content:
            "지금은 학습자 소식을 받고 있지 않아요. 안내 메시지의 [학습자 소식 DM으로 받기]를 눌러 먼저 신청해 주세요.",
        },
      };
    const stop = intent.kind === "subscription_stop";
    if (!stop && current.cadence === intent.cadence)
      return {
        kind: "reply",
        reply: {
          content: `이미 ${CADENCE_LABEL[current.cadence]} 받고 있어요.`,
        },
      };
    const action = stop ? "stop" : intent.cadence;
    return {
      kind: "reply",
      reply: {
        content: stop
          ? "학습자 소식 받기를 그만둘까요? 내 구독만 바뀌어요."
          : `내 학습자 소식을 ${CADENCE_LABEL[intent.cadence]} 받는 것으로 바꿀까요?`,
        components: [
          {
            type: 1,
            components: [
              button(
                "확인",
                chatbotSubscriptionId(userId, action),
                stop ? 4 : 1,
              ),
              button("취소", chatbotSubscriptionId(userId, "cancel"), 2),
            ],
          },
        ],
      },
    };
  }

  private async explainPlan(
    input: { userId: string; scopeKey?: string; text: string },
    intent:
      | { kind: "explain_error"; text: string }
      | { kind: "repo_explain"; owner: string; repo: string },
  ): Promise<ChatbotPlan> {
    if (!this.options.l2Enabled)
      return {
        kind: "reply",
        reply: {
          content:
            "에러·레포 설명은 아직 열지 않았어요. 지금은 아카이브 글 찾기와 학습자 소식 설정을 도와드릴 수 있어요.",
        },
      };
    const history = await this.history(input);
    // L2 replies are text only: no buttons, no store writes, links removed.
    const finalize = (output: string): ChatbotReply => ({
      content: stripLinks(output),
    });
    if (intent.kind === "explain_error")
      return {
        kind: "model",
        feature: "public_qa",
        prompt: buildExplainPrompt("error", redactChat(intent.text), history),
        finalize,
      };
    const overview = this.options.readRepo
      ? await this.options.readRepo(intent.owner, intent.repo).catch(() => null)
      : null;
    if (!overview)
      return {
        kind: "reply",
        reply: {
          content:
            "그 레포를 읽지 못했어요. 공개 레포인지, 주소가 맞는지 확인해 주세요.",
        },
      };
    const material = [
      `레포: ${intent.owner}/${intent.repo}`,
      `설명: ${overview.description}`,
      `최상위 파일: ${overview.entries.map((e) => `${e.name}${e.type === "dir" ? "/" : ""}`).join(", ")}`,
      "README:",
      overview.readme,
    ].join("\n");
    return {
      kind: "model",
      feature: "public_qa",
      prompt: buildExplainPrompt("repo", material, history),
      finalize,
    };
  }

  private async groundedPlan(input: {
    userId: string;
    scopeKey?: string;
    text: string;
  }): Promise<ChatbotPlan> {
    const history = await this.history(input);
    // A short follow-up ("그 글 더 설명해줘") carries no terms of its own.
    const lastUser = [...history]
      .reverse()
      .find((turn) => turn.role === "user");
    const query =
      input.text.length < 15 && lastUser
        ? `${lastUser.content} ${input.text}`
        : input.text;
    const hits = await this.archive.searchArchive(query, ARCHIVE_TOP_K);
    const { relevant, nearest } = splitEvidence(hits);
    if (!relevant.length)
      return {
        kind: "reply",
        reply: { content: formatNoEvidence(nearest) },
      };
    return {
      kind: "model",
      feature: "archive_qa",
      prompt: buildGroundedPrompt(input.text, relevant, history),
      finalize: (output) => ({
        content: finalizeGroundedAnswer(output, relevant),
      }),
    };
  }
}

/**
 * Applies a pressed confirm button. The target is always the person who
 * pressed it, and the id must have been issued for that same person.
 */
export async function handleChatbotSubscriptionComponent(
  learner: Pick<PostgresStore, "learnerSetCadence" | "learnerOptOut">,
  identity: { userId: string },
  customId: string,
): Promise<string> {
  const match = /^chatbot_sub:(\d{15,20}):(daily|weekly|stop|cancel)$/.exec(
    customId,
  );
  if (!match) return "알 수 없는 버튼입니다.";
  const [, owner, action] = match as unknown as [string, string, string];
  if (owner !== identity.userId)
    return "본인의 구독만 바꿀 수 있어요. 직접 라피에게 말해 주세요.";
  if (action === "cancel") return "그대로 둘게요.";
  if (action === "stop") {
    const done = await learner.learnerOptOut(identity.userId);
    return done
      ? "더 이상 소식을 보내지 않을게요. 다시 받고 싶으면 안내 메시지의 버튼을 눌러 주세요."
      : "이미 구독 중이 아니에요.";
  }
  const cadence = action as LearnerCadence;
  const changed = await learner.learnerSetCadence(identity.userId, cadence);
  return changed
    ? `이제 ${CADENCE_LABEL[cadence]} 받아요.`
    : "구독 중이 아니에요. 안내 메시지의 [학습자 소식 DM으로 받기]를 눌러 다시 신청해 주세요.";
}

// --- Unauthenticated GitHub read (L2) ------------------------------------

const REPO_FETCH_TIMEOUT_MS = 6_000;
const README_BYTES = 12_000;

async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

/** README and top-level names only, from api.github.com without credentials. */
export function createGithubRepoReader(
  fetchImpl: typeof fetch = fetch,
): RepoReader {
  const get = (path: string, accept: string): Promise<Response> =>
    fetchImpl(`https://api.github.com${path}`, {
      headers: {
        accept,
        "user-agent": "rapi-agent",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REPO_FETCH_TIMEOUT_MS),
      redirect: "error",
    });
  return async (owner, repo) => {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const meta = await get(base, "application/vnd.github+json");
    if (!meta.ok) return null;
    const info = JSON.parse(await readCapped(meta, 64_000)) as {
      private?: boolean;
      description?: string | null;
    };
    if (info.private) return null;
    const [readme, tree] = await Promise.all([
      get(`${base}/readme`, "application/vnd.github.raw+json"),
      get(`${base}/contents`, "application/vnd.github+json"),
    ]);
    const entries: RepoOverview["entries"] = [];
    if (tree.ok) {
      const parsed = JSON.parse(await readCapped(tree, 200_000)) as unknown;
      if (Array.isArray(parsed))
        for (const entry of parsed.slice(0, 60)) {
          const e = entry as { name?: unknown; type?: unknown };
          if (typeof e.name === "string" && typeof e.type === "string")
            entries.push({ name: e.name.slice(0, 100), type: e.type });
        }
    }
    return {
      description: (info.description ?? "").slice(0, 300),
      readme: readme.ok
        ? (await readCapped(readme, README_BYTES)).slice(0, 6_000)
        : "",
      entries,
    };
  };
}

// --- Blog posts into the archive -------------------------------------------

/** Public MDX posts of apps/blog/content as archive documents. */
export async function loadBlogArchive(
  directory: string,
  baseUrl: string,
): Promise<ArchiveDocument[]> {
  const documents: ArchiveDocument[] = [];
  for (const name of await readdir(directory)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.mdx$/.test(name)) continue;
    const source = await readFile(join(directory, name), "utf8");
    const front = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? "";
    const field = (key: string): string =>
      new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim() ?? "";
    if (field("visibility") !== "public") continue;
    const title = field("title");
    const date = new Date(field("date"));
    if (!title || Number.isNaN(date.getTime())) continue;
    const slug = name.slice(0, -4);
    documents.push({
      key: `blog:${slug}`,
      kind: "blog",
      title,
      summary: field("description").slice(0, 400),
      url: `${baseUrl.replace(/\/$/, "")}/blog/${slug}.html`,
      publishedAt: date,
    });
  }
  return documents;
}
