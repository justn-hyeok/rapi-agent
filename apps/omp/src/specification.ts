import { z } from "zod";
import { providerFields, defaultProviderModel } from "@rapi/contracts";
const permissionSchema = z.enum([
  "repo:read",
  "repo:write",
  "commit:create",
  "push",
  "pull_request:create",
  "deploy",
]);

export const specificationSchema = z
  .object({
    task_id: z.string().min(1),
    task_revision: z.number().int().positive(),
    execution_attempt_id: z.string().min(1),
    approval_id: z.string().min(1),
    approval_expires_at: z.string().datetime({ offset: true }),
    workspace_ref: z.string().min(1),
    ...providerFields,
    goal: z.string().min(1),
    repository: z.string().min(1).optional(),
    base_revision: z.string().min(1).default("HEAD"),
    non_goals: z.array(z.string()).default([]),
    requirements: z.array(z.string()).default([]),
    acceptance_criteria: z.array(z.string()).default([]),
    permissions: z.array(permissionSchema).default([]),
    forbidden_actions: z.array(z.string()).default([]),
    timeout_seconds: z.number().int().min(30).max(7200).default(1800),
  })
  .passthrough()
  .transform(defaultProviderModel);

export type Specification = z.infer<typeof specificationSchema>;
