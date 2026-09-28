import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "node:test";

it("keeps validation and launch on one immutable release when the pointer changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-gateway-launcher-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const pointer = join(root, "current");
  const marker = join(root, "result");
  try {
    for (const release of [first, second]) {
      await mkdir(join(release, "scripts"), { recursive: true });
      await mkdir(join(release, "ops/gateway"), { recursive: true });
    }
    await symlink(first, pointer);
    await writeFile(
      join(first, "scripts/check-withdrawal-support.mjs"),
      `import {unlink,symlink} from 'node:fs/promises'; await unlink(process.env.TEST_POINTER); await symlink(process.env.TEST_SECOND,process.env.TEST_POINTER);`,
    );
    await writeFile(
      join(second, "scripts/check-withdrawal-support.mjs"),
      "throw new Error('Unvalidated old release');",
    );
    await writeFile(
      join(first, "ops/gateway/run.mjs"),
      `import {writeFile} from 'node:fs/promises'; await writeFile(process.env.TEST_MARKER,'validated-first');`,
    );
    await writeFile(
      join(second, "ops/gateway/run.mjs"),
      `throw new Error('Wrong gateway release started');`,
    );
    await promisify(execFile)(
      process.execPath,
      ["scripts/launch-public-gateway.mjs"],
      {
        env: {
          ...process.env,
          RAPI_CURRENT_RELEASE: pointer,
          TEST_POINTER: pointer,
          TEST_SECOND: second,
          TEST_MARKER: marker,
        },
        timeout: 5000,
      },
    );
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(marker, "utf8"), "validated-first");
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        ["scripts/launch-public-gateway.mjs"],
        {
          env: { ...process.env, RAPI_CURRENT_RELEASE: pointer },
          timeout: 5000,
        },
      ),
      /Unvalidated old release/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
