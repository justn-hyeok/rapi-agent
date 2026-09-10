import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import pg from "pg";

const { Client } = pg;
const connectionString =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");

const url = new URL(connectionString);
if (
  process.env.RAPI_ENV === "production" &&
  !["verify-full", "verify-ca"].includes(url.searchParams.get("sslmode") ?? "")
) {
  throw new Error(
    "Production database URL must set sslmode=verify-full or verify-ca",
  );
}

const client = new Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
});
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(731904227)");
  const migrationsDirectory = resolve(
    process.env.RAPI_MIGRATIONS_DIRECTORY ?? "packages/db/migrations",
  );
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const exists = await client.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  if (!exists.rows[0]?.exists) {
    const legacy = await client.query(
      "SELECT to_regclass('public.sources') IS NOT NULL AS exists",
    );
    if (legacy.rows[0]?.exists) {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query(
        "INSERT INTO schema_migrations(name) VALUES('0001_phase_zero.sql') ON CONFLICT DO NOTHING",
      );
      exists.rows[0].exists = true;
    }
  }
  if (exists.rows[0]?.exists) {
    await client.query(`INSERT INTO schema_migrations(name)
      SELECT '0003_chatops.sql'
      WHERE to_regclass('public.chat_channels') IS NOT NULL
        AND to_regclass('public.chat_messages') IS NOT NULL
      ON CONFLICT DO NOTHING`);
  }
  const applied = new Set();
  if (exists.rows[0]?.exists) {
    const rows = await client.query("SELECT name FROM schema_migrations");
    for (const row of rows.rows) applied.add(row.name);
  }
  for (const name of migrations) {
    if (applied.has(name)) continue;
    const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
    await client.query(sql);
    process.stdout.write(`Applied ${name}\n`);
  }
} finally {
  await client
    .query("SELECT pg_advisory_unlock(731904227)")
    .catch(() => undefined);
  await client.end();
}
