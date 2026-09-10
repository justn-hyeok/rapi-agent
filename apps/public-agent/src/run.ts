import { access, chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { runPublicCodex } from "./executor.js";

const socketPath =
  process.env.PUBLIC_AGENT_SOCKET ?? "/run/rapi-public-agent/agent.sock";
const workspace =
  process.env.PUBLIC_AGENT_WORKSPACE ?? "/var/lib/rapi-public/empty";
const runtimeDirectory =
  process.env.PUBLIC_AGENT_RUNTIME ?? "/var/lib/rapi-public/runtime";
const codexBinary =
  process.env.PUBLIC_CODEX_BINARY ?? "/opt/rapi-public-agent/codex";
const codexHome = process.env.CODEX_HOME ?? "/var/lib/rapi-public/codex";
const concurrency = Number(process.env.PUBLIC_AGENT_CONCURRENCY ?? "2");
const healthPort = Number(process.env.PUBLIC_AGENT_HEALTH_PORT ?? "3500");

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
  throw new Error("PUBLIC_AGENT_CONCURRENCY must be between 1 and 8");

await mkdir(dirname(socketPath), { recursive: true });
await mkdir(workspace, { recursive: true, mode: 0o700 });
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
await rm(socketPath, { force: true });

let active = 0;
let stopping = false;

async function body(
  request: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 64_000) throw new Error("request_too_large");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function ready(): Promise<boolean> {
  try {
    await access(codexBinary);
    await access(`${codexHome}/auth.json`);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { alive: true });
    return;
  }
  if (request.method === "GET" && request.url === "/ready") {
    const ok = await ready();
    json(response, ok ? 200 : 503, {
      ready: ok,
      active,
      capacity: concurrency,
    });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/answer") {
    json(response, 404, { error: "not_found" });
    return;
  }
  if (stopping || active >= concurrency) {
    json(response, 429, { error: "capacity" });
    return;
  }
  let prompt: string;
  try {
    const parsed = JSON.parse(await body(request)) as { prompt?: unknown };
    if (typeof parsed.prompt !== "string") throw new Error("invalid_prompt");
    prompt = parsed.prompt;
  } catch (error) {
    json(response, 400, {
      error: error instanceof Error ? error.message : "invalid_request",
    });
    return;
  }
  active += 1;
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const result = await runPublicCodex(prompt, {
      workspace,
      runtimeDirectory,
      binary: codexBinary,
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        HOME: "/var/lib/rapi-public",
        CODEX_HOME: codexHome,
      },
      signal: controller.signal,
      onStarted: () => {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        });
        response.write(`${JSON.stringify({ type: "started" })}\n`);
      },
    });
    if (!result.started) {
      json(response, 500, { error: result.reason });
      return;
    }
    response.end(`${JSON.stringify({ type: "result", ...result })}\n`);
  } catch {
    if (response.headersSent)
      response.end(
        `${JSON.stringify({ type: "result", ok: false, started: true, output: "", reason: "spawn_error" })}\n`,
      );
    else json(response, 500, { error: "executor_failed" });
  } finally {
    active -= 1;
  }
});

const healthServer = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { alive: true });
    return;
  }
  if (request.method === "GET" && request.url === "/ready") {
    const ok = await ready();
    json(response, ok ? 200 : 503, {
      ready: ok,
      active,
      capacity: concurrency,
    });
    return;
  }
  json(response, 404, { error: "not_found" });
});

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  process.stdout.write(`rapi-public-agent listening on ${socketPath}\n`);
});
healthServer.listen(healthPort, "127.0.0.1");

const shutdown = (): void => {
  stopping = true;
  healthServer.close();
  server.close(() => {
    void rm(socketPath, { force: true }).finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
