import pg from "pg";
import { setTimeout } from "node:timers/promises";
import {
  processDeletion,
  finishDeletionFiles,
  finishDeletionBackups,
  sweepMetadata,
} from "./privacy-lifecycle.mjs";
import { privacyConfig, requirePrivacyBackup } from "./privacy-config.mjs";
import { atomicJson } from "./privacy-files.mjs";
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
const maintenance = process.argv.includes("--maintenance");
const once = process.argv.includes("--once") || maintenance;
do {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 30000,
  });
  try {
    await client.connect();
    const config = privacyConfig();
    const requests = (
      await client.query(
        "SELECT id FROM privacy_requests WHERE state IN('confirmed','blocked') AND confirmed_at IS NOT NULL AND target_id IS NOT NULL AND (error_code IS NULL OR error_code IN('active_work','legacy_reply_ownership_unknown','processing_failed')) ORDER BY created_at LIMIT 10",
      )
    ).rows;
    if (requests.length || maintenance) await requirePrivacyBackup();
    for (const request of requests)
      await processDeletion(client, request.id, config);
    const completed = await finishDeletionBackups(client, config);
    const files = (
      await client.query(
        "SELECT id FROM privacy_requests WHERE state='files_pending'",
      )
    ).rows;
    for (const request of files)
      await finishDeletionFiles(client, request.id, config);
    const result = maintenance
      ? await sweepMetadata(client, { ...config, apply: true })
      : { requests: requests.length, completed };
    if (process.env.PRIVACY_STATUS_FILE)
      await atomicJson(process.env.PRIVACY_STATUS_FILE, {
        state: "success",
        lastSuccessAt: new Date().toISOString(),
        result,
      });
    if (once) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    if (process.env.PRIVACY_STATUS_FILE)
      await atomicJson(process.env.PRIVACY_STATUS_FILE, {
        state: "failed",
        lastFailureAt: new Date().toISOString(),
      }).catch(() => undefined);
    process.stderr.write(
      "Data lifecycle processing failed; inspect request state and backup health.\n",
    );
    if (once) process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
  if (!once && !stopped) await setTimeout(15000);
} while (!once && !stopped);
