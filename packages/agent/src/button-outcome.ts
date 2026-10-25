/**
 * What an owner decision button (허용, 발송, 게시, ...) leaves on its message.
 * The Discord transport edits the original message with the composed text.
 */
export interface ButtonOutcome {
  /** Final result line; the buttons are removed unless `components` says otherwise. */
  result?: string;
  /** Pending question (a confirm step) shown under the original text. */
  prompt?: string;
  /** Buttons to leave on the message; omitted means none. */
  components?: unknown[];
  /** Tell only the presser (a refusal or error) and leave the message as it is. */
  notice?: string;
}

const MESSAGE_LIMIT = 2000;
const PROMPT_MARK = "\n\n❓ ";
const RESULT_MARK = "\n\n✅ ";

/** Removes a previous confirm prompt so a second step does not stack on it. */
function stripPrompt(text: string): string {
  const at = text.indexOf(PROMPT_MARK);
  return at === -1 ? text : text.slice(0, at);
}

/** New message text: original, then the pending question or the result with who and when. */
export function composeButtonMessage(
  original: string,
  outcome: ButtonOutcome,
  actorId: string,
  now: Date,
): string {
  const tail = [
    outcome.prompt ? `${PROMPT_MARK}${outcome.prompt}` : "",
    outcome.result
      ? `${RESULT_MARK}${outcome.result}\n처리: <@${actorId}> · <t:${Math.floor(now.getTime() / 1000)}:f>`
      : "",
  ].join("");
  const base = stripPrompt(original);
  const room = MESSAGE_LIMIT - tail.length;
  return `${base.length > room ? `${base.slice(0, Math.max(0, room - 1))}…` : base}${tail}`;
}
