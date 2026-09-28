import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import pg from "pg";
import {
  switchRelease,
  systemdDriver,
  configuredHealthPorts,
} from "./switch-release.mjs";
const envFile = process.env.RAPI_SERVICE_ENV_FILE;
if (process.env.RAPI_SWITCH_APPROVED !== "true" || !envFile)
  throw new Error("Operational authorization and environment file required");
const env = parseEnv(await readFile(envFile, "utf8"));
const candidate = process.env.RAPI_CANDIDATE_RELEASE;
async function schema(action) {
  const client = new pg.Client({
    connectionString: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
  });
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock(731904227)");
    const applied = (
      await client.query(
        "SELECT name FROM schema_migrations WHERE name='0013_data_lifecycle.sql'",
      )
    ).rowCount;
    if (
      (action === "upgrade" && applied) ||
      (action === "rollback" && !applied)
    )
      return;
    await client.query(
      await readFile(
        `${candidate}/${action === "upgrade" ? "packages/db/migrations/0013_data_lifecycle.sql" : "scripts/rollback-data-lifecycle.sql"}`,
        "utf8",
      ),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
await switchRelease({
  currentPath: process.env.RAPI_CURRENT_RELEASE,
  candidatePath: candidate,
  expectedSha: process.env.RAPI_RELEASE_SHA,
  receiptPath: process.env.RAPI_SWITCH_RECEIPT,
  services: process.env.RAPI_SWITCH_SERVICES.split(","),
  driver: systemdDriver(configuredHealthPorts(env)),
  schemaMigration: {
    namesAdded: ["0013_data_lifecycle.sql"],
    upgrade: () => schema("upgrade"),
    rollback: () => schema("rollback"),
  },
});
