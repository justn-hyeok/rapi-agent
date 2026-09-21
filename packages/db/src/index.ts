import { readdir } from "node:fs/promises";

export const migrationsDirectory = new URL("../migrations/", import.meta.url);

export async function expectedMigrationNames(): Promise<string[]> {
  return (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
}

export function compareMigrationNames(
  expected: string[],
  applied: string[],
): { missing: string[]; unexpected: string[]; ok: boolean } {
  const expectedSet = new Set(expected);
  const appliedSet = new Set(applied);
  const missing = expected.filter((name) => !appliedSet.has(name));
  const unexpected = applied.filter((name) => !expectedSet.has(name));
  return {
    missing,
    unexpected,
    ok: missing.length === 0 && unexpected.length === 0,
  };
}

export * from "./postgres-store.js";
export * from "./chatops-store.js";
