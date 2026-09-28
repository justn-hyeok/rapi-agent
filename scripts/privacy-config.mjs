import { readFile, lstat } from "node:fs/promises";
export function privacyConfig(env = process.env) {
  return {
    key: env.PRIVACY_HMAC_KEY,
    withdrawalsFile:
      env.RAPI_BLOG_WITHDRAWALS_FILE ?? "/var/lib/rapi/blog-withdrawals.json",
    publicationRoots: JSON.parse(env.RAPI_PRIVACY_PUBLICATION_ROOTS ?? "[]"),
    backupDirectory:
      env.RAPI_BACKUP_DIRECTORY ?? "/home/justn/rapi-agent/backups",
    backupCatalogFile:
      env.RAPI_BACKUP_CATALOG_FILE ?? "/var/lib/rapi/backup-catalog.json",
    ledgerFile:
      env.RAPI_PRIVACY_LEDGER_FILE ?? "/var/lib/rapi/privacy-ledger.json",
  };
}
export async function requirePrivacyBackup(env = process.env) {
  const status = JSON.parse(
    await readFile(
      env.BACKUP_STATUS_FILE ??
        "/home/justn/rapi-agent/backups/backup-status.json",
      "utf8",
    ),
  );
  const age = Date.now() - new Date(status.lastSuccessAt).getTime();
  if (
    status.state !== "success" ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 26 * 3600000
  )
    throw new Error("fresh_backup_required");
  const stat = await lstat(status.file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size)
    throw new Error("backup_unavailable");
}
