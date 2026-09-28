import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveCodexBinary } from "../scripts/resolve-codex-binary.mjs";

test("public installation copies the native executable instead of a dependency-bearing npm wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-native-"));
  try {
    const wrapper = join(root, "bin/codex.js");
    await mkdir(join(root, "bin"));
    await writeFile(wrapper, "#!/usr/bin/env node\n");
    await assert.rejects(
      resolveCodexBinary(wrapper, "linux", "x64"),
      /refusing to copy/,
    );
    const binary = join(root, "vendor/x86_64-unknown-linux-musl/codex/codex");
    await mkdir(join(root, "vendor/x86_64-unknown-linux-musl/codex"), {
      recursive: true,
    });
    await writeFile(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]));
    assert.equal(
      await resolveCodexBinary(wrapper, "linux", "x64"),
      await realpath(binary),
    );
    assert.equal(
      await resolveCodexBinary(binary, "linux", "x64"),
      await realpath(binary),
    );
    const packageRoot = join(root, "node_modules/@openai/codex-linux-x64");
    await mkdir(join(packageRoot, "vendor/x86_64-unknown-linux-musl/bin"), {
      recursive: true,
    });
    await writeFile(
      join(packageRoot, "package.json"),
      '{"name":"@openai/codex-linux-x64","version":"1.0.0"}',
    );
    const packaged = join(
      packageRoot,
      "vendor/x86_64-unknown-linux-musl/bin/codex",
    );
    await writeFile(packaged, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]));
    assert.equal(
      await resolveCodexBinary(wrapper, "linux", "x64"),
      await realpath(packaged),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
