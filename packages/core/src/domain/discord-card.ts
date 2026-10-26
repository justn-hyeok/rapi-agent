import type { DeliveryPayload } from "./models.js";

/** One Discord embed. Reports and notices share this shape so they read the same. */
export interface DiscordCard {
  title: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
  url?: string;
  color?: number;
}

/** Rapi's accent; warn is for things that need an owner decision. */
export const CARD_COLOR = { info: 0x365d46, warn: 0xb5651d } as const;

// Discord rejects a message above these sizes, so cut here instead of losing the whole report.
const LIMIT = {
  title: 256,
  description: 4000,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  fields: 25,
  total: 5800,
} as const;

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function discordEmbed(card: DiscordCard): Record<string, unknown> {
  return {
    title: clip(card.title, LIMIT.title),
    ...(card.url ? { url: card.url } : {}),
    ...(card.description
      ? { description: clip(card.description, LIMIT.description) }
      : {}),
    ...(card.fields?.length
      ? {
          fields: card.fields.slice(0, LIMIT.fields).map((field) => ({
            name: clip(field.name, LIMIT.fieldName),
            value: clip(field.value, LIMIT.fieldValue) || "-",
            inline: field.inline ?? false,
          })),
        }
      : {}),
    ...(card.footer
      ? { footer: { text: clip(card.footer, LIMIT.footer) } }
      : {}),
    color: card.color ?? CARD_COLOR.info,
  };
}

/**
 * A DM or channel message made of up to ten cards. `text` stays as the plain
 * rendering for delivery logs and adapters that cannot send embeds.
 */
export function cardPayload(
  subject: string,
  text: string,
  cards: DiscordCard[],
): DeliveryPayload {
  const embeds: Record<string, unknown>[] = [];
  let size = 0;
  for (const card of cards.slice(0, 10)) {
    const embed = discordEmbed(card);
    const weight = JSON.stringify(embed).length;
    if (embeds.length && size + weight > LIMIT.total) break;
    embeds.push(embed);
    size += weight;
  }
  return { subject, text, html: "", itemIds: [], discord: { embeds } };
}
