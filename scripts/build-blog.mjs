import { compile, run } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseDocument } from "yaml";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL, URL } from "node:url";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function inertContent() {
  return (tree) => {
    const visit = (node) => {
      if (node.type.startsWith("mdx") || node.type === "html")
        throw new Error(
          "Executable MDX and raw HTML are forbidden in public posts",
        );
      if (node.url && !/^(?:https?:\/\/|\/blog\/)/i.test(node.url))
        throw new Error("Public links must use HTTP(S) or the blog path");
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

function page(title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · 라피</title><link rel="alternate" type="application/rss+xml" href="/blog/feed.xml"><style>
  :root{color-scheme:light dark;--bg:#faf9f5;--fg:#252722;--muted:#65685e;--accent:#365d46;--line:#d9dcd1}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,sans-serif;line-height:1.85;word-break:keep-all;overflow-wrap:anywhere}header,main,footer{max-width:760px;margin:auto;padding:28px 24px}header{display:flex;justify-content:space-between;border-bottom:1px solid var(--line)}header a{text-decoration:none}main{min-height:65vh;padding-top:50px}h1{font-size:clamp(1.8rem,6vw,2.5rem);letter-spacing:-.045em;line-height:1.25;margin:12px 0 36px}h2{font-size:1.35rem;line-height:1.4;margin-top:44px}a{color:var(--accent);text-underline-offset:4px}a:focus-visible{outline:2px solid var(--accent);outline-offset:5px}p,li{font-size:1rem}time,footer{color:var(--muted);font-size:.9rem}code{white-space:pre-wrap;padding:2px 5px;background:var(--line);border-radius:3px}pre{overflow:auto;padding:16px;background:var(--line)}article{padding:24px 0;border-bottom:1px solid var(--line)}article h2{margin:8px 0}article p{margin:8px 0}img{max-width:100%;height:auto}@media(prefers-color-scheme:dark){:root{--bg:#171b18;--fg:#edf1e8;--muted:#a5afa0;--accent:#a6d1ad;--line:#343e34}}@media(max-width:420px){header,main,footer{padding-left:18px;padding-right:18px}header{gap:16px;font-size:.9rem}}
  </style></head><body><header><a href="/blog/">라피 / 기록</a><a href="https://discord.gg/DVbb9uwu8V">Discord 참여 ↗</a></header><main>${body}</main><footer>공개 정보와 라피 사용 안내를 기록합니다. <a href="/blog/feed.xml">RSS</a></footer></body></html>`;
}

export async function buildBlog(contentDirectory, outputDirectory, baseUrl) {
  if (!baseUrl) {
    const configured = JSON.parse(
      await readFile(
        new URL("../config/public-blog.json", import.meta.url),
        "utf8",
      ),
    );
    baseUrl = new URL(
      "/blog/",
      process.env.RAPI_PUBLIC_BASE_URL ?? configured.origin,
    ).href;
  }
  if (!["http:", "https:"].includes(new URL(baseUrl).protocol))
    throw new Error("Blog origin must use HTTP(S)");
  contentDirectory = resolve(contentDirectory);
  outputDirectory = resolve(outputDirectory);
  if (
    contentDirectory === outputDirectory ||
    contentDirectory.startsWith(`${outputDirectory}/`)
  )
    throw new Error("Blog output cannot contain its sources");
  const posts = [];
  for (const name of await readdir(contentDirectory)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.mdx$/.test(name)) continue;
    const source = join(contentDirectory, name);
    if (!(await lstat(source)).isFile())
      throw new Error("Blog sources must be regular files");
    const content = await readFile(source, "utf8");
    if (Buffer.byteLength(content) > 1_000_000)
      throw new Error("Blog source exceeds 1 MB");
    const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
      content,
    );
    if (!frontmatter) continue;
    const document = parseDocument(frontmatter[1], { uniqueKeys: true });
    if (document.errors.length || document.get("visibility") !== "public")
      continue;
    const title = document.get("title");
    if (typeof title !== "string" || !title.trim())
      throw new Error("A public post needs a title");
    const compiled = await compile(content.slice(frontmatter[0].length), {
      outputFormat: "function-body",
      remarkPlugins: [inertContent],
    });
    const { default: Content } = await run(compiled, {
      ...runtime,
      baseUrl: import.meta.url,
    });
    const body = renderToStaticMarkup(createElement(Content));
    const slug = name.slice(0, -4);
    const rawDate = document.get("date") ?? document.get("generatedAt");
    const date = new Date(typeof rawDate === "string" ? rawDate : "1970-01-01");
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid post date");
    posts.push({
      slug,
      title,
      description: String(document.get("description") ?? ""),
      date: date.toISOString(),
      html: page(
        title,
        `<time datetime="${date.toISOString()}">${date.toISOString().slice(0, 10)}</time>${body}`,
      ),
    });
  }
  posts.sort(
    (a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug),
  );
  // Compile and validate every post before touching any output.
  let previous = false;
  try {
    const info = await lstat(outputDirectory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Blog output must be an owned directory");
    const names = await readdir(outputDirectory);
    if (names.length && !names.includes("blog-build.json"))
      throw new Error("Refusing to replace unowned output");
    previous = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(outputDirectory), { recursive: true });
  const staged = await mkdtemp(`${outputDirectory}.stage-`);
  const backup = `${outputDirectory}.previous-${randomUUID()}`;
  const targetDirectory = outputDirectory;
  outputDirectory = staged;
  try {
    for (const post of posts)
      await writeFile(join(outputDirectory, `${post.slug}.html`), post.html);
    await writeFile(
      join(outputDirectory, "index.html"),
      page(
        "라피 기록",
        `<h1>질문에서 시작한 기록.</h1><p>라피 사용 안내와 공개 브리핑을 모았습니다.</p>${posts.map((p) => `<article><time datetime="${p.date}">${p.date.slice(0, 10)}</time><h2><a href="/blog/${p.slug}.html">${escape(p.title)}</a></h2><p>${escape(p.description)}</p></article>`).join("")}`,
      ),
    );
    await writeFile(
      join(outputDirectory, "feed.xml"),
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>라피 기록</title><link>${escape(baseUrl)}</link><description>라피의 공개 기록</description>${posts.map((p) => `<item><title>${escape(p.title)}</title><link>${escape(new URL(`${p.slug}.html`, baseUrl).href)}</link><guid>${escape(new URL(`${p.slug}.html`, baseUrl).href)}</guid><description>${escape(p.description)}</description><pubDate>${new Date(p.date).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`,
    );
    await writeFile(
      join(outputDirectory, "blog-build.json"),
      JSON.stringify({ version: 1, baseUrl, posts: posts.map((p) => p.slug) }),
    );
    if (previous) await rename(targetDirectory, backup);
    try {
      await rename(staged, targetDirectory);
    } catch (error) {
      if (previous) await rename(backup, targetDirectory);
      throw error;
    }
    if (previous) await rm(backup, { recursive: true });
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  return posts.map((p) => p.slug);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await buildBlog(
    resolve(process.argv[2] ?? "apps/blog/content"),
    resolve(process.argv[3] ?? "apps/blog/dist"),
  );
