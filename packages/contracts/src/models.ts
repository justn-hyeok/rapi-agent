import { z } from "zod";

export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex-spark";

export const codexModelSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]+$/);

const aliases: Record<string, string> = {
  spark: DEFAULT_CODEX_MODEL,
  "codex spark": DEFAULT_CODEX_MODEL,
  "codex-spark": DEFAULT_CODEX_MODEL,
  "codex 5.3 spark": DEFAULT_CODEX_MODEL,
  "codex-5.3-spark": DEFAULT_CODEX_MODEL,
  "5.3 codex spark": DEFAULT_CODEX_MODEL,
  스파크: DEFAULT_CODEX_MODEL,
  astra: "gpt-6-astra",
  아스트라: "gpt-6-astra",
  sol: "gpt-5.6-sol",
  솔: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  테라: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
  루나: "gpt-5.6-luna",
};

const modelName =
  "스파크|spark|codex(?:[- ]5\\.3)?[- ]spark|5\\.3[- ]codex[- ]spark|아스트라|astra|솔|sol|테라|terra|루나|luna|gpt-[a-z0-9._-]+";

export function resolveCodexModel(value?: string): string {
  if (!value?.trim()) return DEFAULT_CODEX_MODEL;
  const normalized = value.trim().toLowerCase();
  return codexModelSchema.parse(aliases[normalized] ?? normalized);
}

export function parseModelDirective(input: string): {
  model: string;
  task: string;
  explicit: boolean;
} {
  const text = input.trim();
  const labeled = text.match(
    new RegExp(`^모델\\s*[:=]\\s*(${modelName})\\s*[,，]?\\s+(.+)$`, "i"),
  );
  if (labeled)
    return {
      model: resolveCodexModel(labeled[1]),
      task: labeled[2]!.trim(),
      explicit: true,
    };
  const prefix = text.match(
    new RegExp(
      `^(?:모델\\s*[:=]?\\s*)?(${modelName})\\s*(?:모델)?\\s*(?:로|으로)\\s*[,：:]?\\s*(.+)$`,
      "i",
    ),
  );
  if (prefix)
    return {
      model: resolveCodexModel(prefix[1]),
      task: prefix[2]!.trim(),
      explicit: true,
    };

  const suffix = text.match(
    new RegExp(
      `^(.+?)\\s*[,，]?\\s*(?:모델\\s*[:=]\\s*|모델은\\s*)(${modelName})\\s*$`,
      "i",
    ),
  );
  if (suffix)
    return {
      model: resolveCodexModel(suffix[2]),
      task: suffix[1]!.trim(),
      explicit: true,
    };

  return { model: DEFAULT_CODEX_MODEL, task: text, explicit: false };
}
