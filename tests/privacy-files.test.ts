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
import { removePublication } from "../scripts/privacy-files.mjs";
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
