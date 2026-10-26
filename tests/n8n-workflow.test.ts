import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { compileFunction } from "node:vm";
import { AutomationNotifier } from "@rapi/agent";

interface WorkflowNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
}
interface Workflow {
  nodes: WorkflowNode[];
  connections: Record<string, { main: { node: string }[][] }>;
}

const workflow = JSON.parse(
  await readFile(
    new URL("../ops/n8n/rapi-blog-announce.workflow.json", import.meta.url),
    "utf8",
  ),
) as Workflow;
const node = (name: string): WorkflowNode =>
  workflow.nodes.find((n) => n.name === name)!;

const nodeRequire = createRequire(import.meta.url);
const secret = "test".repeat(6);

/** What n8n hands the Code node for a webhook with rawBody on. */
async function captureRequest(
  options: { at?: Date; key?: string } = {},
): Promise<{ headers: Record<string, string>; body: string }> {
  let captured: { headers: Record<string, string>; body: string } | undefined;
  await new AutomationNotifier({
    url: "https://automation.example/hook",
    secret: options.key ?? secret,
    now: () => options.at ?? new Date(),
    fetch: (async (_url: string, init: RequestInit) => {
      captured = {
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      };
      return new Response("ok");
    }) as unknown as typeof fetch,
  }).notify({
    type: "blog.published",
    data: {
      slug: "g",
      title: "입문 가이드",
      url: "https://rapi.example/blog/g.html",
    },
  });
  return captured!;
}

function runCode(
  name: string,
  input: Record<string, unknown>,
  env: Record<string, string> = { RAPI_AUTOMATION_SECRET: secret },
): { json: Record<string, unknown> } {
  const code = node(name).parameters.jsCode as string;
  const run = compileFunction(code, [
    "require",
    "Buffer",
    "$input",
    "$env",
  ]) as (...args: unknown[]) => { json: Record<string, unknown> }[];
  return run(nodeRequire, Buffer, { first: () => input }, env)[0]!;
}

const incoming = (request: {
  headers: Record<string, string>;
  body: string;
}) => ({
  json: { headers: request.headers },
  binary: { data: { data: Buffer.from(request.body).toString("base64") } },
});

test("the workflow accepts exactly what Rapi sends", async () => {
  const result = runCode("Verify signature", incoming(await captureRequest()));
  assert.equal(result.json.valid, true);
  assert.equal(
    (result.json.event as { data: { slug: string } }).data.slug,
    "g",
  );
});

test("the workflow drops a tampered body, a wrong secret, a stale request and other events", async () => {
  const good = await captureRequest();
  const tampered = { ...good, body: good.body.replace("입문 가이드", "공지") };
  assert.equal(
    runCode("Verify signature", incoming(tampered)).json.valid,
    false,
  );
  assert.equal(
    runCode("Verify signature", incoming(good), {
      RAPI_AUTOMATION_SECRET: "other".repeat(4),
    }).json.valid,
    false,
  );
  const stale = await captureRequest({
    at: new Date(Date.now() - 10 * 60_000),
  });
  assert.equal(runCode("Verify signature", incoming(stale)).json.valid, false);
  const missing = { json: { headers: {} }, binary: incoming(good).binary };
  assert.equal(runCode("Verify signature", missing).json.valid, false);
  // A correctly signed request of another kind is still not a blog announcement.
  const other = await captureRequest();
  const body = other.body.replace("blog.published", "something.else");
  const { createHmac } = await import("node:crypto");
  const sig = `sha256=${createHmac("sha256", secret).update(`${other.headers["x-rapi-timestamp"]}.${body}`).digest("hex")}`;
  const forged = {
    headers: { ...other.headers, "x-rapi-signature": sig },
    body,
  };
  assert.equal(runCode("Verify signature", incoming(forged)).json.valid, false);
});

test("the announcement cannot mention anyone or smuggle markup", () => {
  const out = runCode("Format announcement", {
    json: {
      event: {
        data: {
          title: "@everyone <b>공지</b>\n새 글",
          url: "https://rapi.example/blog/g.html",
        },
      },
    },
  });
  const content = out.json.content as string;
  assert.ok(!/[@<>]/.test(content));
  assert.ok(!content.includes("\n새 글"));
  assert.ok(content.endsWith("https://rapi.example/blog/g.html"));
  assert.deepEqual(out.json.allowed_mentions, { parse: [] });
  const noUrl = runCode("Format announcement", {
    json: { event: { data: { title: "t", url: "javascript:alert(1)" } } },
  });
  assert.ok(!(noUrl.json.content as string).includes("javascript"));
});

test("the workflow is wired end to end and listens where the docs say", async () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  for (const [from, links] of Object.entries(workflow.connections)) {
    assert.ok(names.has(from), from);
    for (const branch of links.main)
      for (const link of branch) assert.ok(names.has(link.node), link.node);
  }
  assert.equal(node("Rapi event").type, "n8n-nodes-base.webhook");
  assert.equal(node("Rapi event").parameters.path, "rapi-blog");
  assert.deepEqual(node("Rapi event").parameters.options, { rawBody: true });
  const docs = await readFile(
    new URL("../docs/n8n.md", import.meta.url),
    "utf8",
  );
  assert.ok(docs.includes("/webhook/rapi-blog"));
  const compose = await readFile(
    new URL("../ops/n8n/compose.yaml", import.meta.url),
    "utf8",
  );
  assert.match(compose, /127\.0\.0\.1:5678:5678/);
  assert.match(compose, /NODE_FUNCTION_ALLOW_BUILTIN: crypto/);
});
