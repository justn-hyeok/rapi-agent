/** Everything a reader sees in a Discord message: its text plus each card's title, body and fields. */
export function shown(
  message:
    | { content?: string | undefined; embeds?: unknown[] | undefined }
    | undefined,
): string {
  const parts = [message?.content ?? ""];
  for (const raw of message?.embeds ?? []) {
    const embed = raw as {
      title?: string;
      description?: string;
      fields?: Array<{ name: string; value: string }>;
      footer?: { text: string };
    };
    parts.push(
      embed.title ?? "",
      embed.description ?? "",
      ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]),
      embed.footer?.text ?? "",
    );
  }
  return parts.filter(Boolean).join("\n");
}
