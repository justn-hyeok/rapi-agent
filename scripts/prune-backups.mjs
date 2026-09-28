import { lstat, readdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function expiredBackups(names, now, days = 30) {
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > 3650 ||
    !Number.isFinite(now.getTime())
  )
    throw new Error("Invalid backup retention");
  return names
    .filter((name) => {
      const match =
        /^rapi-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/.exec(name);
      if (!match) return false;
      const date = new Date(
        `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
      );
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().replace(/[-:]/g, "").replace(".000", "") !==
          name.slice(5, -5)
      )
        return false;
      return date.getTime() < now.getTime() - days * 86_400_000;
    })
    .sort();
}

export async function prune(directory, now = new Date(), days = 30) {
  const root = resolve(directory);
  if (
    !(await lstat(root)).isDirectory() ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new Error("Backup directory must be a real directory");
  const names = expiredBackups(await readdir(root), now, days);
  const removed = [];
  for (const name of names) {
    const file = join(root, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    await unlink(file);
    removed.push(name);
  }
  return removed;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const removed = await prune(
    process.argv[2],
    new Date(),
    Number(process.env.BACKUP_RETENTION_DAYS ?? 30),
  );
  process.stdout.write(
    `${JSON.stringify({ retentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 30), removed })}\n`,
  );
}
