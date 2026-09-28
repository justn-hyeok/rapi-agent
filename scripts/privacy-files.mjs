import {
  lstat,
  readFile,
  writeFile,
  rename,
  unlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { expiredBackups } from "./prune-backups.mjs";

export async function atomicJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
async function regular(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe_file");
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function removePublication(action, roots) {
  const stat = await regular(action.path);
  if (!stat) return "absent";
  const canonical = await realpath(action.path);
  const allowed = await Promise.all(
    roots.map((root) => realpath(root).catch(() => resolve(root))),
  );
  if (
    !action.path.endsWith(".mdx") ||
    !allowed.some((root) => canonical.startsWith(`${root}/`))
  )
    throw new Error("unowned_file");
  const hash = createHash("sha256")
    .update(await readFile(action.path))
    .digest("hex");
  if (hash !== action.hash) throw new Error("changed_file");
  await unlink(action.path);
  return "removed";
}
export async function backupInventory(
  directory,
  catalogFile,
  now = new Date(),
) {
  const entries = [];
  const root = await realpath(directory);
  for (const name of await readdir(root)) {
    if (!/^rapi-\d{8}T\d{6}Z\.dump$/.test(name)) continue;
    const file = join(root, name);
    const stat = await regular(file);
    if (!stat) continue;
    if ((await realpath(file)) !== resolve(file))
      throw new Error("unsafe_backup");
    // File names are owned by the backup producer. Validate dates too.
    if (!expiredBackups([name], new Date("9999-12-31T23:59:59Z"), 30).length)
      throw new Error("invalid_backup_date");
    entries.push({
      managed: true,
      path: file,
      expiresAt: new Date(stat.mtimeMs + 30 * 86400000).toISOString(),
    });
  }
  const catalog = catalogFile
    ? await readJson(catalogFile, { version: 1, entries: [] })
    : { version: 1, entries: [] };
  if (catalog.version !== 1 || !Array.isArray(catalog.entries))
    throw new Error("invalid_backup_catalog");
  for (const entry of catalog.entries) {
    const stat = await regular(entry.path);
    if (!stat) continue;
    if (
      !entry.path.endsWith(".dump") ||
      !Number.isFinite(new Date(entry.expiresAt).getTime())
    )
      throw new Error("invalid_backup_catalog");
    if (new Date(entry.expiresAt) <= now) {
      if (
        (await realpath(entry.path)) !== entry.path ||
        stat.size !== entry.size ||
        stat.mtimeMs !== entry.mtimeMs
      )
        throw new Error("changed_catalog_backup");
      await unlink(entry.path);
    } else
      entries.push({
        path: entry.path,
        expiresAt: entry.expiresAt,
        managed: false,
      });
  }
  return entries;
}
export async function registerBackup(
  catalogFile,
  file,
  roots,
  now = new Date(),
) {
  const stat = await regular(file);
  const canonical = await realpath(file);
  const allowed = await Promise.all(
    roots.map((root) => realpath(root).catch(() => resolve(root))),
  );
  if (
    !stat ||
    !file.endsWith(".dump") ||
    !allowed.some((root) => canonical.startsWith(`${root}/`))
  )
    throw new Error("unowned_backup");
  const catalog = await readJson(catalogFile, { version: 1, entries: [] });
  if (catalog.version !== 1 || !Array.isArray(catalog.entries))
    throw new Error("invalid_backup_catalog");
  if (!catalog.entries.some((entry) => entry.path === canonical))
    catalog.entries.push({
      path: canonical,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
    });
  await atomicJson(catalogFile, catalog);
}
export async function backupsGone(entries) {
  for (const entry of entries) if (await regular(entry.path)) return false;
  return true;
}
export async function updateLedger(file, request) {
  const lockFile = `${file}.lock`;
  let lock;
  for (let i = 0; i < 100 && !lock; i++) {
    try {
      lock = await open(lockFile, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Do not remove another writer's lock automatically. Interrupted writes
      // require operator recovery with both writers stopped.
      await setTimeout(50);
    }
  }
  if (!lock) throw new Error("privacy_ledger_busy");
  try {
    const ledger = await readJson(file, { version: 1, requests: [] });
    if (ledger.version !== 1 || !Array.isArray(ledger.requests))
      throw new Error("invalid_privacy_ledger");
    const previous = ledger.requests.find((entry) => entry.id === request.id);
    const rank = {
      confirmed: 0,
      files_pending: 1,
      waiting_backups: 2,
      completed: 3,
    };
    if (previous && (rank[previous.state] ?? -1) > (rank[request.state] ?? -1))
      return;
    ledger.requests = ledger.requests.filter(
      (entry) => entry.id !== request.id,
    );
    ledger.requests.push(request);
    await atomicJson(file, ledger);
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}
