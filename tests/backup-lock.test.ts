import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("records backup failure when the lock wrapper cannot connect before invoking pg_dump", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-backup-lock-"));
  const status = join(root, "status.json");
  try {
    await writeFile(
      status,
      JSON.stringify({
        state: "success",
        lastSuccessAt: new Date().toISOString(),
      }),
    );
    await assert.rejects(
      promisify(execFile)(process.execPath, ["scripts/backup-with-lock.mjs"], {
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://test:test@127.0.0.1:1/rapi_test",
          BACKUP_STATUS_FILE: status,
        },
        timeout: 5000,
      }),
    );
    const result = JSON.parse(await readFile(status, "utf8")) as {
      state: string;
      lastFailureAt?: string;
    };
    assert.equal(result.state, "failed");
    assert(result.lastFailureAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
