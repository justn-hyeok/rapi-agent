import { z } from "zod";

const csvIds = z
  .string()
  .min(1)
  .transform((value) => value.split(",").map((part) => part.trim()))
  .pipe(z.array(z.string().regex(/^\d+$/)).min(1));

export const environmentSchema = z
  .object({
    RAPI_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    RAPI_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    DATABASE_URL: z
      .string()
      .url()
      .refine((url) => url.startsWith("postgresql://"), {
        message: "DATABASE_URL must use postgresql://",
      }),
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
    DISCORD_PUBLIC_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    DISCORD_ALLOWED_USER_IDS: csvIds,
    DISCORD_SUPERADMIN_USER_IDS: csvIds.optional(),
    DISCORD_ADMIN_USER_IDS: csvIds.optional(),
    DISCORD_USER_IDS: csvIds.optional(),
    DISCORD_ADMIN_ROLE_IDS: csvIds.optional(),
    DISCORD_USER_ROLE_IDS: csvIds.optional(),
    DISCORD_ALLOWED_GUILD_IDS: csvIds.optional(),
    DISCORD_ALLOWED_CHANNEL_IDS: csvIds.optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    EMAIL_TRANSPORT: z.enum(["smtp", "api"]).optional(),
    EMAIL_FROM: z.string().email().optional(),
    EMAIL_TEST_RECIPIENTS: z.string().optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USERNAME: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    OMP_ENDPOINT: z.string().url().optional(),
    OMP_CALLBACK_SECRET: z.string().min(16).optional(),
    WEBHOOK_SECRET: z.string().min(16).optional(),
    GITHUB_READ_TOKEN: z.string().min(1).optional(),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(300),
    DELIVERY_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(3600),
  })
  .superRefine((value, context) => {
    if (value.RAPI_ENV !== "production") return;
    if (value.EMAIL_TRANSPORT === "smtp") {
      for (const key of [
        "EMAIL_FROM",
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_USERNAME",
        "SMTP_PASSWORD",
      ] as const) {
        if (!value[key])
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required for SMTP`,
          });
      }
    }
  });

export type Environment = z.infer<typeof environmentSchema>;
export function loadEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): Environment {
  const parsed = environmentSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}
