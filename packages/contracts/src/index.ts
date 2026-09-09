import { z } from "zod";
import { providerFields, defaultProviderModel } from "./providers.js";

export const visibilitySchema = z.enum(["private", "unlisted", "public"]);
export const deliveryStateSchema = z.enum([
  "draft",
  "ready",
  "sending",
  "partially_failed",
  "retrying",
  "delivered",
  "failed",
  "dead_letter",
]);
export const taskStateSchema = z.enum([
  "draft",
  "awaiting_approval",
  "approved",
  "dispatched",
  "running",
  "blocked",
  "completed",
  "failed",
  "rejected",
  "expired",
  "cancelled",
]);
export const taskPermissionSchema = z.enum([
  "repo:read",
  "repo:write",
  "commit:create",
  "push",
  "pull_request:create",
  "deploy",
]);

const identifierSchema = z.string().min(1).max(200);
const isoDateTimeSchema = z.string().datetime({ offset: true });

export const taskSpecificationSchema = z
  .object({
    task_id: identifierSchema,
    task_revision: z.number().int().positive(),
    execution_attempt_id: identifierSchema,
    repository: z.string().min(1),
    base_revision: z.string().min(1),
    workspace_ref: z.string().min(1),
    ...providerFields,
    goal: z.string().min(1),
    non_goals: z.array(z.string()),
    requirements: z.array(z.string().min(1)).min(1),
    acceptance_criteria: z.array(z.string().min(1)).min(1),
    permissions: z.array(taskPermissionSchema),
    forbidden_actions: z.array(z.string().min(1)),
    approval_id: identifierSchema,
    approval_expires_at: isoDateTimeSchema,
    timeout_seconds: z.number().int().positive(),
    result_report_ref: z.string().min(1),
    required_evidence: z.array(z.string().min(1)),
  })
  .transform(defaultProviderModel);

export const executionCallbackSchema = z.object({
  callback_event_id: identifierSchema,
  receipt_id: identifierSchema,
  execution_attempt_id: identifierSchema,
  state_version: z.number().int().nonnegative(),
  state: z.enum(["running", "blocked", "completed", "failed", "cancelled"]),
  occurred_at: isoDateTimeSchema,
  reason: z.string().optional(),
  result_report_ref: z.string().optional(),
  evidence_refs: z.array(z.string()).default([]),
  key_id: identifierSchema,
  signature: z.string().min(1),
});

export type DeliveryState = z.infer<typeof deliveryStateSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskSpecification = z.infer<typeof taskSpecificationSchema>;
export type ExecutionCallback = z.infer<typeof executionCallbackSchema>;

export * from "./chatops.js";
export * from "./models.js";

export * from "./providers.js";
