import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { expiredBackups, prune } from "../scripts/prune-backups.mjs";

it("expires by age rather than backup count, preserving the boundary and unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-retention-"));
  const old = "rapi-20260801T000000Z.dump";
  const link = "rapi-20260701T000000Z.dump";
  const boundary = "rapi-20260829T000000Z.dump";
  try {
    for (const name of [
      old,
      boundary,
      "rapi-20260231T000000Z.dump",
      "restore-evidence.dump",
    ])
      await writeFile(join(root, name), name);
    await symlink(join(root, "restore-evidence.dump"), join(root, link));
    assert.deepEqual(
      expiredBackups(
        [old, boundary, "rapi-20260231T000000Z.dump"],
        new Date("2026-09-28T00:00:00Z"),
      ),
      [old],
    );
    assert.deepEqual(await prune(root, new Date("2026-09-28T00:00:00Z")), [
      old,
    ]);
    assert.equal((await readdir(root)).length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
