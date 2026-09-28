import pg from "pg";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { atomicJson, readJson } from "./privacy-files.mjs";
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
});
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(731552024)");
  const child = spawn("/bin/bash", ["scripts/backup.sh"], {
    env: { ...process.env, RAPI_BACKUP_LOCK_HELD: "1" },
    stdio: "inherit",
  });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error("Backup child failed");
} catch {
  const file = process.env.BACKUP_STATUS_FILE ?? "backups/backup-status.json";
  const previous = await readJson(file, {});
  await atomicJson(file, {
    ...previous,
    state: "failed",
    lastFailureAt: new Date().toISOString(),
  });
  process.stderr.write("Backup failed before successful completion.\n");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
