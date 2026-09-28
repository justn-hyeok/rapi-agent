import { lstat, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const validSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export async function readWithdrawals(file, required = false) {
  if (!file) {
    if (required) throw new Error("Withdrawal file is required");
    return [];
  }
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Invalid withdrawal file");
    const data = JSON.parse(await readFile(file, "utf8"));
    if (
      data.version !== 1 ||
      !Array.isArray(data.slugs) ||
      data.slugs.some(
        (slug) => typeof slug !== "string" || !validSlug.test(slug),
      )
    )
      throw new Error("Invalid withdrawal state");
    return data.slugs;
  } catch (error) {
    if (!required && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function recordWithdrawals(file, slugs) {
  if (
    !file ||
    resolve(file) !== file ||
    slugs.some((slug) => !validSlug.test(slug))
  )
    throw new Error("Canonical withdrawal file and valid slugs required");
  const root = await lstat(dirname(file));
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("Invalid withdrawal directory");
  const combined = [
    ...new Set([...(await readWithdrawals(file)), ...slugs]),
  ].sort();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, slugs: combined, updatedAt: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return combined;
}

export function filterWithdrawnBlog(name, body, slugs) {
  if (slugs.some((slug) => !validSlug.test(slug)))
    throw new Error("Invalid withdrawal slug");
  if (slugs.some((slug) => name === `${slug}.html`)) return null;
  const text = body.toString("utf8");
  const containsWithdrawn = (entry) =>
    slugs.some((slug) => entry.includes(`/blog/${slug}.html`));
  if (name === "index.html")
    return Buffer.from(
      text.replace(/<article>[\s\S]*?<\/article>/g, (entry) =>
        containsWithdrawn(entry) ? "" : entry,
      ),
    );
  if (name === "feed.xml")
    return Buffer.from(
      text.replace(/<item>[\s\S]*?<\/item>/g, (entry) =>
        containsWithdrawn(entry) ? "" : entry,
      ),
    );
  return body;
}
