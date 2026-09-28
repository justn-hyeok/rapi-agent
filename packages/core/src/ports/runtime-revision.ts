import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readRuntimeRevision(directory: string): string | null {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(directory, "release-manifest.json"), "utf8"),
    );
    if (
      manifest &&
      typeof manifest === "object" &&
      "sha" in manifest &&
      typeof manifest.sha === "string" &&
      /^[a-f0-9]{40}$/.test(manifest.sha)
    )
      return manifest.sha;
  } catch {
    /* Development checkouts have no staged release manifest. */
  }
  return null;
}

// Capture at boot. Replacing the current symlink cannot relabel an old process.
export const runtimeRevision = readRuntimeRevision(process.cwd());
