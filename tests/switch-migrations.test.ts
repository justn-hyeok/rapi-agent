import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { additiveSchemaMigration } from "../scripts/switch-release.mjs";
import { releaseFileDigests } from "../scripts/release-artifact.mjs";

async function stage(
  root: string,
  name: string,
  sha: string,
  migrations: string[],
  rollbacks: string[],
): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, "packages/db/migrations"), { recursive: true });
  await mkdir(join(path, "packages/db/rollbacks"), { recursive: true });
  for (const migration of migrations)
    await writeFile(
      join(path, "packages/db/migrations", migration),
      `-- up ${migration}\n`,
    );
  for (const migration of rollbacks)
    await writeFile(
      join(path, "packages/db/rollbacks", migration),
      `-- down ${migration}\n`,
    );
  await writeFile(
    join(path, "release-manifest.json"),
    JSON.stringify({
      sha,
      tree: sha,
      stagedPath: path,
      verifiedAt: new Date().toISOString(),
      gates: [
        "npm ci",
        "check",
        "web-proxy:test",
        "test:e2e",
        "restart:smoke",
        "restore:smoke",
        "audit:prod",
      ],
      switched: false,
      files: await releaseFileDigests(path),
      migrations,
    }),
  );
  return path;
}

test("switch migrations require a rollback and undo in reverse order", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rapi-migrate-")));
  const previous = await stage(
    root,
    "previous",
    "1".repeat(40),
    ["0001_a.sql"],
    [],
  );
  const current = join(root, "current");
  await symlink(previous, current);

  const missing = await stage(
    root,
    "missing",
    "2".repeat(40),
    ["0001_a.sql", "0002_b.sql"],
    [],
  );
  await assert.rejects(
    additiveSchemaMigration({
      currentPath: current,
      candidatePath: missing,
      connectionString: "postgres://x",
    }),
    /0002_b\.sql has no rollback/,
  );

  const same = await stage(root, "same", "3".repeat(40), ["0001_a.sql"], []);
  assert.equal(
    await additiveSchemaMigration({
      currentPath: current,
      candidatePath: same,
      connectionString: "postgres://x",
    }),
    undefined,
  );

  const good = await stage(
    root,
    "good",
    "4".repeat(40),
    ["0001_a.sql", "0002_b.sql", "0003_c.sql"],
    ["0002_b.sql", "0003_c.sql"],
  );
  const queries: string[] = [];
  const plan = await additiveSchemaMigration({
    currentPath: current,
    candidatePath: good,
    connectionString: "postgres://x",
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        queries.push(values ? `${sql} ${JSON.stringify(values)}` : sql.trim());
        return {
          rows: sql.startsWith("SELECT name") ? [{ name: "0002_b.sql" }] : [],
        };
      },
      end: async () => undefined,
    }),
  });
  assert.deepEqual(plan?.namesAdded, ["0002_b.sql", "0003_c.sql"]);
  await plan!.upgrade();
  // An already-applied migration is not run twice.
  assert.ok(!queries.includes("-- up 0002_b.sql"));
  assert.ok(queries.includes("-- up 0003_c.sql"));
  queries.length = 0;
  await plan!.rollback();
  const downs = queries.filter((q) => q.startsWith("-- down"));
  assert.deepEqual(downs, ["-- down 0003_c.sql", "-- down 0002_b.sql"]);
  assert.ok(
    queries.some(
      (q) =>
        q.includes('"0003_c.sql"') &&
        q.startsWith("DELETE FROM schema_migrations"),
    ),
  );
});

test("every migration after 0014 ships a rollback", async () => {
  const migrations = (await readdir("packages/db/migrations")).filter((n) =>
    /^\d+.*\.sql$/.test(n),
  );
  const rollbacks = new Set(await readdir("packages/db/rollbacks"));
  for (const name of migrations)
    if (Number(name.slice(0, 4)) > 14)
      assert.ok(
        rollbacks.has(name),
        `${name} needs packages/db/rollbacks/${name}`,
      );
});
