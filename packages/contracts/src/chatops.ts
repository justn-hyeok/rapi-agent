import { createHash } from "node:crypto";
import { z } from "zod";
import { codexModelSchema } from "./models.js";

export const chatRouteSchema = z.enum([
  "answer",
  "execute",
  "status",
  "cancel",
  "remember",
  "memory_list",
  "forget",
  "loop",
]);
export type ChatRoute = z.infer<typeof chatRouteSchema>;
export const runPhaseSchema = z.enum([
  "prepared",
  "accepted",
  "running",
  "reported_done",
  "verified",
  "failed",
  "cancel_requested",
  "cancelled",
  "interrupted",
]);
export type RunPhase = z.infer<typeof runPhaseSchema>;
export const scopeSchema = z
  .object({
    guild: z.string().min(1).max(100),
    channel: z.string().min(1).max(100),
    owner: z.string().min(1).max(100),
  })
  .strict();
export type ChatScope = z.infer<typeof scopeSchema>;
export const discordChatMessageSchema = z.object({
  id: z.string().min(1).max(100),
  guild_id: z.string().max(100).optional(),
  channel_id: z.string().min(1).max(100),
  content: z.string().max(20000),
  author: z.object({
    id: z.string().min(1).max(100),
    bot: z.boolean().optional(),
  }),
  member: z
    .object({
      roles: z.array(z.string().min(1).max(100)).default([]),
    })
    .optional(),
});
export type DiscordChatMessage = z.infer<typeof discordChatMessageSchema>;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const gitObservationSchema = z
  .object({
    head: z.string().max(64),
    status: z.string().max(4000),
    digest: digestSchema,
  })
  .strict();
export type GitObservation = z.infer<typeof gitObservationSchema>;
export const runEvidenceSchema = z
  .object({
    attempt: z.number().int().min(0).max(3).optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().max(30).nullable().optional(),
    reason: z
      .enum([
        "exit",
        "cancel",
        "timeout",
        "spawn_error",
        "restart",
        "no_progress",
        "blocked",
        "budget",
        "unknown",
      ])
      .optional(),
    before: gitObservationSchema.optional(),
    after: gitObservationSchema.optional(),
    verification: z
      .object({
        command: z.literal("git diff --check"),
        exitCode: z.number().int(),
        revision: digestSchema,
        taskDigest: digestSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type RunEvidence = z.infer<typeof runEvidenceSchema>;
export const chatRunSchema = z.object({
  id: z.string().uuid(),
  guild_id: z.string(),
  channel_id: z.string(),
  owner_id: z.string(),
  message_id: z.string(),
  route: z.enum(["execute", "loop"]),
  phase: runPhaseSchema,
  model: codexModelSchema,
  task_digest: digestSchema,
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  evidence: runEvidenceSchema,
});
export type ChatRun = z.infer<typeof chatRunSchema>;
export const memorySchema = z.object({
  id: z.string().uuid(),
  content: z.string().max(2000),
  digest: digestSchema,
  revision: z.number().int().positive(),
  state: z.enum(["candidate", "approved", "superseded", "forgotten"]),
  message_id: z.string(),
});
export type ChatMemory = z.infer<typeof memorySchema>;
export function textDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function redactChat(text: string): string {
  let safe = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|PRIVATE_KEY|CURSOR|CREDENTIAL/i.test(
        key,
      ) &&
      value &&
      value.length >= 4
    )
      safe = safe.split(value).join("[REDACTED]");
  }
  return safe
    .replace(
      /("[^"\n]*(?:token|secret|password|api[_-]?key|credential|authorization)[^"\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED]",
    )
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/gi, "[REDACTED]")
    .replace(
      /\b(?:sk-[\w-]{10,}|gh[pousr]_[\w]{10,}|github_pat_[\w]{10,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:authorization|cookie|token|secret|password|api[_-]?key|cmd_api_key|cursor[\w.-]*(?:credential|auth|token)[\w.-]*)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}
