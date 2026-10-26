import type { ModelClient } from "@rapi/adapters";
import type { GraphStore, Retriever } from "@rapi/core";
import type { ChatbotArchive } from "./chatbot.js";
import { GraphRetriever, HybridRetriever } from "./graph.js";
import { LlmRerankRetriever, lexicalRetriever } from "./retrieval.js";

/** Keyword hits count double next to graph hits when both are fused. */
const TEXT_WEIGHT = 2;
const GRAPH_WEIGHT = 1;

/**
 * The chatbot's archive search, assembled from the flags: keyword search, widened
 * and reranked by a model when asked for (and a model API exists), and fused with
 * the knowledge graph when asked for. With no flags it is plain keyword search.
 */
export function createArchiveRetriever(
  config: { CHATBOT_RERANK_ENABLED: boolean; CHATBOT_GRAPH_ENABLED: boolean },
  parts: {
    archive: ChatbotArchive;
    model: ModelClient | null;
    graph: GraphStore;
    onWarning?: (message: string) => void;
  },
): Retriever {
  const keyword = lexicalRetriever(parts.archive);
  const text =
    config.CHATBOT_RERANK_ENABLED && parts.model
      ? new LlmRerankRetriever(keyword, parts.model, {
          ...(parts.onWarning
            ? {
                onFallback: (reason: string) =>
                  parts.onWarning?.(`archive rerank fallback: ${reason}`),
              }
            : {}),
        })
      : keyword;
  return config.CHATBOT_GRAPH_ENABLED
    ? new HybridRetriever(
        [text, new GraphRetriever(parts.graph)],
        [TEXT_WEIGHT, GRAPH_WEIGHT],
      )
    : text;
}
