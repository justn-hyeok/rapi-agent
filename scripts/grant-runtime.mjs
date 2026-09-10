import { URL } from "node:url";
import pg from "pg";

const { Client } = pg;
const connectionString = process.env.MIGRATION_DATABASE_URL;
const role = process.env.RAPI_RUNTIME_DATABASE_ROLE;
if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required");
if (!role || !/^[a-z_][a-z0-9_]{0,62}$/.test(role))
  throw new Error(
    "RAPI_RUNTIME_DATABASE_ROLE must be a simple PostgreSQL role name",
  );
const url = new URL(connectionString);
if (
  process.env.RAPI_ENV === "production" &&
  !["verify-full", "verify-ca"].includes(url.searchParams.get("sslmode") ?? "")
)
  throw new Error("Production database URL must verify TLS certificates");

const identifier = `"${role.replaceAll('"', '""')}"`;
const client = new Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
});
await client.connect();
try {
  const exists = await client.query(
    "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists",
    [role],
  );
  if (!exists.rows[0]?.exists)
    throw new Error(`PostgreSQL role ${role} does not exist`);
  await client.query("BEGIN");
  await client.query(
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(url.pathname.slice(1))} TO ${identifier}`,
  );
  await client.query(`GRANT USAGE ON SCHEMA public TO ${identifier}`);
  await client.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${identifier}`,
  );
  await client.query(
    `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${identifier}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${identifier}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${identifier}`,
  );
  for (const apiRole of ["anon", "authenticated"]) {
    const apiRoleExists = await client.query(
      "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists",
      [apiRole],
    );
    if (!apiRoleExists.rows[0]?.exists) continue;
    await client.query(`REVOKE ALL ON SCHEMA public FROM "${apiRole}"`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "${apiRole}"`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "${apiRole}"`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM "${apiRole}"`,
    );
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

function quoteIdentifier(value) {
  if (!value)
    throw new Error("Database name is missing from MIGRATION_DATABASE_URL");
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Database name contains unsupported characters");
  return `"${value}"`;
}
