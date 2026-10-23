import { discordChatMessageSchema } from "@rapi/contracts";

/**
 * Direct messages never reach ChatOps. A subscriber's DM is only counted as a
 * voluntary reply: who and when, no content, and no answer or execution.
 */
export async function countDirectReply(
  raw: unknown,
  recordReply: (userId: string) => Promise<boolean>,
): Promise<"counted" | "ignored"> {
  const parsed = discordChatMessageSchema.safeParse(raw);
  if (!parsed.success) return "ignored";
  const message = parsed.data;
  if (message.guild_id || message.author.bot) return "ignored";
  return (await recordReply(message.author.id)) ? "counted" : "ignored";
}

export function isDirectMessage(raw: unknown): boolean {
  const parsed = discordChatMessageSchema.safeParse(raw);
  return parsed.success && !parsed.data.guild_id;
}
