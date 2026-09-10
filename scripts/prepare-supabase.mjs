import { chmod, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { URL } from "node:url";

const outputFile = process.argv[2];
if (!outputFile) throw new Error("runtime URL output file이 필요합니다.");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const raw = Buffer.concat(chunks)
  .toString("utf8")
  .replace(/\r?\n$/, "");
const admin = new URL(raw);
if (
  admin.protocol !== "postgresql:" ||
  admin.port !== "5432" ||
  !admin.hostname.endsWith(".pooler.supabase.com")
)
  throw new Error(
    "Supabase Session pooler의 postgresql:// URL과 5432 포트가 필요합니다.",
  );
admin.searchParams.set("sslmode", "verify-full");
const runtimePassword = randomBytes(32).toString("base64url");
const runtime = new URL(admin);
runtime.username = admin.username.replace(/^postgres(?=\.|$)/, "rapi_runtime");
if (!runtime.username.startsWith("rapi_runtime"))
  throw new Error(
    "관리자 Session pooler username은 postgres 또는 postgres.<ref>여야 합니다.",
  );
runtime.password = runtimePassword;

const client = new pg.Client({
  connectionString: admin.toString(),
  connectionTimeoutMillis: 5_000,
  query_timeout: 5_000,
});
await client.connect();
let serverMajor;
try {
  const version = await client.query(
    "SELECT current_database(), current_setting('server_version_num')::int AS version_num",
  );
  if (!version.rows[0]) throw new Error("Supabase 연결 확인에 실패했습니다.");
  serverMajor = Math.floor(Number(version.rows[0].version_num) / 10_000);
  const exists = await client.query(
    "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rapi_runtime') AS exists",
  );
  const password = runtimePassword.replaceAll("'", "''");
  if (exists.rows[0]?.exists)
    await client.query(
      `ALTER ROLE rapi_runtime WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
  else
    await client.query(
      `CREATE ROLE rapi_runtime WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
} finally {
  await client.end();
}

const pgDump = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
const pgDumpMajor = Number(
  pgDump.stdout?.match(/PostgreSQL\)\s+(\d+)/)?.[1] ?? 0,
);
if (pgDump.status !== 0 || pgDumpMajor < serverMajor)
  throw new Error(
    `Supabase PostgreSQL ${serverMajor}과 호환되는 pg_dump가 필요합니다. 현재: ${pgDumpMajor || "없음"}`,
  );

function run(script, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAPI_ENV: "production",
      MIGRATION_DATABASE_URL: admin.toString(),
      ...extraEnv,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${script} 실행에 실패했습니다.`);
}
run("scripts/migrate.mjs");
run("scripts/grant-runtime.mjs", {
  RAPI_RUNTIME_DATABASE_ROLE: "rapi_runtime",
});

const runtimeClient = new pg.Client({
  connectionString: runtime.toString(),
  connectionTimeoutMillis: 5_000,
  query_timeout: 5_000,
});
await runtimeClient.connect();
try {
  await runtimeClient.query("SELECT count(*) FROM schema_migrations");
  await runtimeClient.query("SELECT count(*) FROM ai_usage_policies");
} finally {
  await runtimeClient.end();
}
await writeFile(outputFile, `${runtime.toString()}\n`, {
  mode: 0o600,
  flag: "wx",
});
await chmod(outputFile, 0o600);
process.stdout.write(
  "Supabase migration/runtime 역할/TLS 검사를 통과했습니다.\n",
);
