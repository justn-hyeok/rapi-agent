import { createRequire } from "node:module";
import { open, realpath, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function elf(path) {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    await file.read(header, 0, 4, 0);
    return header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    await file.close();
  }
}

export async function resolveCodexBinary(
  entry,
  platform = process.platform,
  arch = process.arch,
) {
  const cli = await realpath(entry);
  if (await elf(cli)) return cli;
  const target =
    platform === "linux" && arch === "x64"
      ? "x86_64-unknown-linux-musl"
      : platform === "linux" && arch === "arm64"
        ? "aarch64-unknown-linux-musl"
        : null;
  if (!target)
    throw new Error("Public executor requires a supported Linux native binary");
  const roots = [resolve(dirname(cli), "../vendor")];
  try {
    const packageFile = createRequire(cli).resolve(
      `@openai/codex-linux-${arch}/package.json`,
    );
    roots.unshift(join(dirname(packageFile), "vendor"));
  } catch {
    /* Older bundled distributions place vendor beside bin. */
  }
  for (const root of roots) {
    for (const suffix of [
      ["bin", "codex"],
      ["codex", "codex"],
    ]) {
      const binary = join(root, target, ...suffix);
      try {
        await access(binary);
        if (await elf(binary)) return binary;
      } catch {
        /* Try the next supported distribution layout. */
      }
    }
  }
  throw new Error(
    "Could not resolve the native Codex binary; refusing to copy the npm wrapper",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.stdout.write(`${await resolveCodexBinary(process.argv[2])}\n`);
