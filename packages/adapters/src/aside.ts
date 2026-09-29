import { z } from "zod";
import type { ExternalItem } from "./sources.js";

export const ASIDE_LOCATOR = "https://news.ycombinator.com/";
export const ASIDE_ADAPTER = "hacker-news-v1";
const story = z
  .object({
    id: z.string().regex(/^\d{1,16}$/),
    title: z.string().trim().min(1).max(500),
    articleUrl: z
      .string()
      .url()
      .max(2000)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }),
    author: z.string().max(100).nullable(),
  })
  .strict();

export const asideSnapshotSchema = z
  .object({
    sourceId: z.string().uuid(),
    token: z.string().uuid(),
    adapter: z.literal(ASIDE_ADAPTER),
    pageUrl: z.literal(ASIDE_LOCATOR),
    collectedAt: z.string().datetime(),
    stories: z.array(story).min(1).max(30),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.stories.map((item) => item.id)).size !==
      value.stories.length
    )
      context.addIssue({ code: "custom", message: "Duplicate story IDs" });
  });
export type AsideSnapshot = z.infer<typeof asideSnapshotSchema>;

export function asideItems(snapshot: AsideSnapshot): ExternalItem[] {
  return snapshot.stories.map((item) => ({
    externalId: `hn:${item.id}`,
    url: `https://news.ycombinator.com/item?id=${item.id}`,
    title: item.title,
    body: `${item.title}\n${item.articleUrl}`,
    author: item.author,
    publishedAt: null,
    metadata: {
      adapter: ASIDE_ADAPTER,
      provenance: {
        method: "aside-browser",
        pageUrl: snapshot.pageUrl,
        collectedAt: snapshot.collectedAt,
      },
      articleUrl: item.articleUrl,
    },
  }));
}
