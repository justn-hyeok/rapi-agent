import { z } from "zod";
import {
  DEFAULT_CODEX_MODEL,
  parseModelDirective,
  resolveCodexModel,
} from "./models.js";

export const providerSchema = z.enum(["codex", "cursor", "commandcode"]);
export type Provider = z.infer<typeof providerSchema>;
export const providerModelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
export const providerFields = {
  provider: providerSchema.default("codex"),
  model: providerModelSchema.optional(),
};
export function defaultProviderModel<
  T extends { provider: Provider; model?: string | undefined },
>(value: T): T {
  return {
    ...value,
    model:
      value.model ??
      (value.provider === "codex" ? DEFAULT_CODEX_MODEL : undefined),
  };
}
const aliases: Record<string, Provider> = {
  codex: "codex",
  코덱스: "codex",
  cursor: "cursor",
  커서: "cursor",
  commandcode: "commandcode",
  "command code": "commandcode",
  goat: "commandcode",
  고트: "commandcode",
  커맨드코드: "commandcode",
};
export function resolveProvider(value?: string): Provider {
  if (value === undefined) return "codex";
  return providerSchema.parse(aliases[value.trim().toLowerCase()] ?? value);
}
export function resolveProviderSelection(value: {
  provider?: unknown;
  model?: unknown;
}): { provider: Provider; model?: string | undefined } {
  const provider =
    value.provider === undefined
      ? "codex"
      : resolveProvider(z.string().parse(value.provider));
  const model =
    value.model === undefined
      ? undefined
      : providerModelSchema.parse(
          provider === "codex"
            ? resolveCodexModel(z.string().parse(value.model))
            : value.model,
        );
  return defaultProviderModel({ provider, model });
}
// Only an unquoted directive at the start of this request selects a provider.
export function parseProviderDirective(input: string): {
  provider: Provider;
  task: string;
  explicit: boolean;
} {
  const text = input.trim();
  const match = text.match(
    /^(codex|코덱스|cursor|커서|command\s+code|commandcode|goat|고트|커맨드코드)(?:(?:으로|로)\s+|\s*:\s+)(\S[\s\S]*)$/i,
  );
  return match
    ? {
        provider: resolveProvider(match[1]!.replace(/\s+/g, " ")),
        task: match[2]!.trim(),
        explicit: true,
      }
    : { provider: "codex", task: text, explicit: false };
}
export function parseTaskSelection(
  content: string,
  providerOption?: string,
  modelOption?: string,
) {
  const directive = parseProviderDirective(content);
  const provider =
    providerOption === undefined
      ? directive.provider
      : resolveProvider(providerOption);
  const modelDirective =
    provider === "codex" ? parseModelDirective(directive.task) : undefined;
  return {
    ...resolveProviderSelection({
      provider,
      model: modelOption ?? modelDirective?.model,
    }),
    task: modelDirective?.task ?? directive.task,
  };
}
