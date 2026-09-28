import assert from "node:assert/strict";
import { it } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  removePublication,
  updateLedger,
  readJson,
} from "../scripts/privacy-files.mjs";

it("keeps every request during concurrent ledger writes and never regresses completed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-privacy-ledger-"));
  const file = join(root, "ledger.json");
  try {
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        updateLedger(file, { id: String(i), state: "waiting_backups" }),
      ),
    );
    await updateLedger(file, { id: "0", state: "completed" });
    await updateLedger(file, { id: "0", state: "confirmed" });
    const result = await readJson<{
      version: number;
      requests: Array<{ id: string; state: string }>;
    }>(file, { version: 1, requests: [] });
    assert.equal(result.requests.length, 15);
    assert.equal(result.requests.find((r) => r.id === "0")?.state, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("preserves changed files, symlinks and paths outside publication roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-privacy-files-"));
  const owned = join(root, "owned");
  await mkdir(owned);
  const body = "owned generated publication";
  const hash = createHash("sha256").update(body).digest("hex");
  const outside = join(root, "outside.mdx");
  const file = join(owned, "post.mdx");
  try {
    await writeFile(outside, body);
    await assert.rejects(
      removePublication({ path: outside, hash }, [owned]),
      /unowned/,
    );
    await symlink(outside, file);
    await assert.rejects(
      removePublication({ path: file, hash }, [owned]),
      /unsafe/,
    );
    await rm(file);
    await writeFile(file, "replacement");
    await assert.rejects(
      removePublication({ path: file, hash }, [owned]),
      /changed/,
    );
    assert.equal(await readFile(file, "utf8"), "replacement");
    await writeFile(file, body);
    assert.equal(
      await removePublication({ path: file, hash }, [owned]),
      "removed",
    );
    assert.equal(
      await removePublication({ path: file, hash }, [owned]),
      "absent",
    );
    assert.equal(await readFile(outside, "utf8"), body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
