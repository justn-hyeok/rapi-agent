import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { registerBackup } from "./privacy-files.mjs";
import { privacyConfig } from "./privacy-config.mjs";
const config = privacyConfig();
const roots = JSON.parse(process.env.RAPI_BACKUP_CATALOG_ROOTS ?? "[]");
let registered = 0;
async function walk(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Unsafe catalog root");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && entry.name.endsWith(".dump")) {
      await registerBackup(config.backupCatalogFile, path, roots);
      registered++;
    }
  }
}
for (const root of roots) await walk(root);
process.stdout.write(`${JSON.stringify({ registered })}\n`);
