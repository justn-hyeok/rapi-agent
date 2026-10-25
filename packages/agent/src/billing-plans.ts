import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { BillingPlan } from "@rapi/core";

const planSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(60),
  description: z.string().max(300),
  priceKrw: z.number().int().min(0).max(10_000_000),
  periodDays: z.number().int().min(1).max(3650),
  features: z.array(z.string().min(1).max(60)),
});

const plansFileSchema = z
  .object({ plans: z.array(planSchema) })
  .superRefine((file, context) => {
    const seen = new Set<string>();
    for (const plan of file.plans) {
      if (seen.has(plan.id))
        context.addIssue({
          code: "custom",
          path: ["plans"],
          message: `duplicate plan id ${plan.id}`,
        });
      seen.add(plan.id);
    }
  });

export function parseBillingPlans(text: string): BillingPlan[] {
  return plansFileSchema.parse(JSON.parse(text)).plans;
}

/** Default is `ops/billing-plans.json`; `BILLING_PLANS_FILE` overrides it. */
export async function loadBillingPlans(path?: string): Promise<BillingPlan[]> {
  const file =
    path ?? new URL("../../../ops/billing-plans.json", import.meta.url);
  return parseBillingPlans(await readFile(file, "utf8"));
}
