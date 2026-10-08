import { createHash } from "node:crypto";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { resolve, relative, join } from "node:path";

export async function releaseFileDigests(root) {
  const files = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        ["node_modules", ".git", "tests", "release-manifest.json"].includes(
          entry.name,
        )
      )
        continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Release contains a symlink");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files[relative(root, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  }
  await walk(root);
  return files;
}

export async function verifyRelease(root, expectedSha) {
  const path = resolve(root);
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error("Release path must be canonical and not a symlink");
  const manifest = JSON.parse(
    await readFile(join(path, "release-manifest.json"), "utf8"),
  );
  if (
    !/^[a-f0-9]{40}$/.test(manifest.sha) ||
    (expectedSha && manifest.sha !== expectedSha) ||
    manifest.stagedPath !== path ||
    manifest.switched !== false
  )
    throw new Error("Release identity mismatch");
  const required = [
    "npm ci",
    "check",
    "web-proxy:test",
    "test:e2e",
    "restart:smoke",
    "restore:smoke",
    "audit:prod",
  ];
  // A CI-verified release relies on GitHub CI for check, E2E and audit of
  // the same SHA and proves only build and migration restore on the host.
  const ciVerified = ["npm ci", "build", "restore:smoke", "github-ci"];
  if (
    !(
      required.every((gate) => manifest.gates?.includes(gate)) ||
      ciVerified.every((gate) => manifest.gates?.includes(gate))
    ) ||
    !manifest.files ||
    !Array.isArray(manifest.migrations)
  )
    throw new Error("Release verification evidence is incomplete");
  const actual = await releaseFileDigests(path);
  const expected = manifest.files;
  if (
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(actual).some(([name, digest]) => expected[name] !== digest)
  )
    throw new Error("Release file digest mismatch");
  const migrations = (await readdir(join(path, "packages/db/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (JSON.stringify(migrations) !== JSON.stringify(manifest.migrations))
    throw new Error("Release migration set mismatch");
  return manifest;
}
