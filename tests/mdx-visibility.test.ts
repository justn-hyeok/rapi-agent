import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MdxPublisher } from "@rapi/adapters";
import { renderMdx } from "@rapi/core";

test("failed publication cleanup preserves replacements and files outside its directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-mdx-cleanup-"));
  const content = join(root, "content");
  const publisher = new MdxPublisher(content, join(root, "public"));
  const hash = createHash("sha256").update("generated content").digest("hex");
  try {
    const file = await publisher.publish("owned", "generated content");
    await writeFile(file, "newer replacement");
    assert.equal(await publisher.removeIfUnchanged(file, hash), false);
    const outside = join(root, "outside.mdx");
    await writeFile(outside, "generated content");
    await assert.rejects(publisher.removeIfUnchanged(outside, hash), /outside/);
    await publisher.publish("owned", "generated content");
    assert.equal(await publisher.removeIfUnchanged(file, hash), true);
    assert.deepEqual(await readdir(content), []);
    assert((await readdir(root)).includes("outside.mdx"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated MDX treats source JSX, expressions and link punctuation as text", () => {
  const mdx = renderMdx(
    "brief",
    "<Title>{x}",
    "public",
    [
      {
        id: "item",
        title: "<Script>{run()}",
        summary: "{process.env.SECRET}\n<script>alert(1)</script>",
        canonicalUrl: "https://example.invalid/a(b)",
        categories: [],
        visibility: "public",
      },
    ],
    new Date("2026-09-28T00:00:00Z"),
  );
  const body = mdx.split("---\n")[2]!;
  assert.doesNotMatch(body, /<script|\{process|<Title|<Script/);
  assert.match(body, /&#123;process/);
  assert.match(body, /a%28b%29/);
});

test("public MDX build uses only unique, valid frontmatter visibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-mdx-"));
  const content = join(root, "content");
  const output = join(root, "public");
  await mkdir(content);
  try {
    const fixtures = {
      "private.mdx": "---\nvisibility: private\n---\nvisibility: public\n",
      "unlisted.mdx": "---\nvisibility: unlisted\n---\nvisibility: public\n",
      "body-only.mdx": "visibility: public\n",
      "duplicate.mdx": "---\nvisibility: private\nvisibility: public\n---\n",
      "malformed.mdx": "---\nvisibility: [public\n---\n",
      "public.mdx": '---\nvisibility: "public"\n---\nHello\n',
    };
    for (const [name, body] of Object.entries(fixtures))
      await writeFile(join(content, name), body);
    const publisher = new MdxPublisher(content, output);
    await publisher.buildPublic();
    assert.deepEqual(await readdir(output), ["public.mdx"]);
    await writeFile(
      join(content, "public.mdx"),
      "---\nvisibility: private\n---\n",
    );
    await publisher.buildPublic();
    assert.deepEqual(await readdir(output), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
