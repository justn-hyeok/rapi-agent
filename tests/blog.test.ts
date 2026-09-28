import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlog } from "../scripts/build-blog.mjs";

test("MDX blog renders only public posts and removes withdrawn output atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-blog-"));
  const content = join(root, "content");
  const output = join(root, "output");
  await mkdir(content);
  const post = (visibility: string) =>
    `---\ntitle: 공개 기록\ndate: 2026-09-28\nvisibility: ${visibility}\n---\n# 공개 기록\n\n[출처](https://example.com/)\n`;
  try {
    await writeFile(join(content, "public.mdx"), post("public"));
    await writeFile(
      join(content, "private.mdx"),
      post("private") + "비밀 본문",
    );
    await buildBlog(content, output);
    assert.match(
      await readFile(join(output, "public.html"), "utf8"),
      /href="https:\/\/example.com\/"/,
    );
    assert(!(await readdir(output)).includes("private.html"));
    await writeFile(
      join(content, "public.mdx"),
      post("public") + "{process.env.SECRET}",
    );
    await assert.rejects(buildBlog(content, output), /Executable MDX/);
    assert.match(
      await readFile(join(output, "public.html"), "utf8"),
      /공개 기록/,
    );
    await writeFile(join(content, "public.mdx"), post("private"));
    await buildBlog(content, output);
    assert(!(await readdir(output)).includes("public.html"));
    assert(
      !(await readFile(join(output, "feed.xml"), "utf8")).includes(
        "public.html",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public blog refuses raw HTML, executable imports, unsafe links and unknown output", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-blog-guards-"));
  try {
    const content = join(root, "content");
    const output = join(root, "output");
    await mkdir(content);
    for (const body of [
      "<script>alert(1)</script>",
      "export const x = process.env.SECRET",
      "[link](javascript:alert%281%29)",
    ]) {
      await writeFile(
        join(content, "post.mdx"),
        `---\ntitle: 글\nvisibility: public\n---\n${body}`,
      );
      await assert.rejects(buildBlog(content, output));
    }
    await writeFile(
      join(content, "post.mdx"),
      "---\ntitle: 글\nvisibility: public\n---\n# 글",
    );
    await mkdir(output);
    await writeFile(join(output, "user-data.txt"), "keep");
    await assert.rejects(buildBlog(content, output), /unowned/);
    assert.equal(await readFile(join(output, "user-data.txt"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
