import { z } from "zod";

const csvIds = z
  .string()
  .min(1)
  .transform((value) => value.split(",").map((part) => part.trim()))
  .pipe(z.array(z.string().regex(/^\d+$/)).min(1));

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

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
    DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
    DB_CONNECT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30000)
      .default(5000),
    DB_QUERY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30000)
      .default(5000),
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
    DISCORD_PUBLIC_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    DISCORD_ALLOWED_USER_IDS: csvIds,
    DISCORD_SUPERADMIN_USER_IDS: csvIds.optional(),
    DISCORD_ADMIN_USER_IDS: csvIds.optional(),
    DISCORD_USER_IDS: csvIds.optional(),
    DISCORD_ADMIN_ROLE_IDS: csvIds.optional(),
    DISCORD_USER_ROLE_IDS: csvIds.optional(),
    DISCORD_GUILD_MEMBERS_ARE_USERS: booleanString,
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
    WEBHOOK_ENCRYPTION_KEY: z
      .string()
      .refine((value) => {
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      }, "WEBHOOK_ENCRYPTION_KEY must be 32 bytes encoded as base64")
      .optional(),
    RAPI_PUBLIC_BASE_URL: z.string().url().optional(),
    PUBLIC_TUNNEL_VERIFIED_FILE: z
      .string()
      .default("/var/lib/rapi/tunnel-verified.json"),
    MONITOR_STATE_FILE: z.string().default("/var/lib/rapi/monitor-state.json"),
    MONITOR_PORT: z.coerce.number().int().min(1).max(65535).default(3300),
    CHAT_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    PUBLIC_AGENT_SOCKET: z
      .string()
      .default("/run/rapi-public-agent/agent.sock"),
    PUBLIC_AGENT_READY_URL: z
      .string()
      .url()
      .default("http://127.0.0.1:3500/ready"),
    PUBLIC_AGENT_HEALTH_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(3500),
    PUBLIC_GATEWAY_READY_URL: z
      .string()
      .url()
      .default("http://127.0.0.1:3601/ready"),
    CLOUDFLARE_TUNNEL_READY_URL: z
      .string()
      .url()
      .default("http://127.0.0.1:3700/ready"),
    RAPI_ADMIN_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    DISCORD_LAYOUT_FILE: z
      .string()
      .default("/home/justn/rapi-agent/config/discord-channels.yaml"),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3400),
    OPERATIONS_CHANNEL_ID: z.string().regex(/^\d+$/).optional(),
    OPERATIONS_DISCORD_WEBHOOK_URL: z.string().url().optional(),
    OPERATIONS_DISCORD_WEBHOOK_CIPHERTEXT: z.string().min(1).optional(),
    DATABASE_SIZE_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(500_000_000),
    MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
    BOT_READY_URL: z.string().url().default("http://127.0.0.1:3000/ready"),
    CHAT_READY_URL: z.string().url().default("http://127.0.0.1:3100/ready"),
    WORKER_READY_URL: z.string().url().default("http://127.0.0.1:3400/ready"),
    OMP_READY_URL: z.string().url().default("http://127.0.0.1:3200/ready"),
    BACKUP_STATUS_FILE: z.string().default("backups/backup-status.json"),
    GITHUB_READ_TOKEN: z.string().min(1).optional(),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(300),
    DELIVERY_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(3600),
    COMMUNITY_GUILD_ID: z.string().regex(/^\d+$/).optional(),
    TECHNICAL_RSS_WEBHOOK_NAME: z.string().default("technical-rss-output"),
  })
  .superRefine((value, context) => {
    if (value.RAPI_PUBLIC_BASE_URL && !value.WEBHOOK_ENCRYPTION_KEY) {
      context.addIssue({
        code: "custom",
        path: ["WEBHOOK_ENCRYPTION_KEY"],
        message:
          "WEBHOOK_ENCRYPTION_KEY and RAPI_PUBLIC_BASE_URL must be configured together",
      });
    }
    if (
      value.OPERATIONS_DISCORD_WEBHOOK_CIPHERTEXT &&
      !value.WEBHOOK_ENCRYPTION_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPERATIONS_DISCORD_WEBHOOK_CIPHERTEXT"],
        message: "encrypted operations webhook requires WEBHOOK_ENCRYPTION_KEY",
      });
    }
    if (
      value.RAPI_PUBLIC_BASE_URL &&
      !value.RAPI_PUBLIC_BASE_URL.startsWith("https://")
    ) {
      context.addIssue({
        code: "custom",
        path: ["RAPI_PUBLIC_BASE_URL"],
        message: "RAPI_PUBLIC_BASE_URL must use HTTPS",
      });
    }
    if (value.RAPI_ENV !== "production") return;
    try {
      const databaseUrl = new URL(value.DATABASE_URL);
      const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
        databaseUrl.hostname,
      );
      if (
        !isLoopback &&
        !["verify-full", "verify-ca"].includes(
          databaseUrl.searchParams.get("sslmode") ?? "",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message:
            "production DATABASE_URL must set sslmode=verify-full or verify-ca",
        });
      }
    } catch {
      // The URL field reports malformed connection strings.
    }
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
