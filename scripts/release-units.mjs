import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  readFile,
  mkdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const paths = {
  bot: "apps/bot/src/run.ts",
  chat: "apps/chat/src/run.ts",
  omp: "apps/omp/src/run.ts",
  worker: "workers/runtime/src/run.ts",
  monitor: "apps/monitor/src/run.ts",
};

export function releaseUnitContents({
  currentPath,
  environmentPath,
  nodeBinary,
}) {
  for (const value of [currentPath, environmentPath, nodeBinary]) {
    if (
      typeof value !== "string" ||
      !value.startsWith("/") ||
      !/^[a-zA-Z0-9_./-]+$/.test(value) ||
      resolve(value) !== value
    )
      throw new Error(
        "Unit paths must be canonical absolute paths without whitespace",
      );
  }
  return Object.fromEntries(
    Object.entries(paths).map(([name, source]) => [
      `rapi-${name}.service`,
      [
        "[Service]",
        `WorkingDirectory=${currentPath}`,
        "ExecStart=",
        `ExecStart=${nodeBinary} --env-file=${environmentPath} --import tsx ${source}`,
        ...(name === "monitor"
          ? [
              `Environment=BACKUP_STATUS_FILE=${resolve(environmentPath, "..", "backups/backup-status.json")}`,
            ]
          : []),
        "",
      ].join("\n"),
    ]),
  );
}

export async function installReleaseUnits({
  currentPath,
  environmentPath,
  nodeBinary,
  unitRoot,
  receiptPath,
  reload,
}) {
  const contents = releaseUnitContents({
    currentPath,
    environmentPath,
    nodeBinary,
  });
  if (
    !(await lstat(currentPath)).isSymbolicLink() ||
    !(await lstat(environmentPath)).isFile()
  )
    throw new Error(
      "Existing release pointer and regular environment file required",
    );
  const before = {};
  const targets = {};
  for (const unit of Object.keys(contents)) {
    const directory = join(unitRoot, `${unit}.d`);
    const target = join(directory, "10-rapi-release.conf");
    targets[unit] = target;
    try {
      if ((await lstat(directory)).isSymbolicLink())
        throw new Error("Drop-in directory must not be a symlink");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      if (!(await lstat(target)).isFile())
        throw new Error("Drop-in must be a regular file");
      before[unit] = await readFile(target, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      before[unit] = null;
    }
  }
  await writeFile(
    receiptPath,
    `${JSON.stringify({ currentPath, environmentPath, targets, before, applied: false }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const changed = [];
  try {
    for (const [unit, content] of Object.entries(contents)) {
      const directory = join(unitRoot, `${unit}.d`);
      await mkdir(directory, { recursive: true });
      const temporary = `${targets[unit]}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
        await rename(temporary, targets[unit]);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      changed.push(unit);
    }
    await reload();
    await writeFile(
      receiptPath,
      `${JSON.stringify({ currentPath, environmentPath, targets, before, applied: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    for (const unit of changed.reverse()) {
      if (before[unit] === null) await unlink(targets[unit]);
      else await writeFile(targets[unit], before[unit]);
    }
    await reload();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options = {
    currentPath: process.env.RAPI_CURRENT_RELEASE,
    environmentPath: process.env.RAPI_SERVICE_ENV_FILE,
    nodeBinary: process.env.RAPI_NODE_BINARY ?? "/usr/bin/node",
  };
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && !["--preview", "--apply"].includes(args[0]))
  )
    throw new Error("Use --preview or --apply");
  if (args[0] !== "--apply")
    process.stdout.write(
      `${JSON.stringify(releaseUnitContents(options), null, 2)}\n`,
    );
  else {
    if (
      process.env.RAPI_RELEASE_UNITS_APPROVED !== "true" ||
      !process.env.RAPI_RELEASE_UNITS_RECEIPT
    )
      throw new Error("Explicit approval and recovery receipt path required");
    await installReleaseUnits({
      ...options,
      unitRoot: "/etc/systemd/system",
      receiptPath: process.env.RAPI_RELEASE_UNITS_RECEIPT,
      reload: () =>
        promisify(execFile)("systemctl", ["daemon-reload"], {
          timeout: 30_000,
        }),
    });
  }
}
