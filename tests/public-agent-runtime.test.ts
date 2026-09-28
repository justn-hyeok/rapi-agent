import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PublicAgentClient } from "@rapi/adapters";
import { runPublicCodex } from "../apps/public-agent/src/executor.js";

test("public agent reserves capacity before reading uploads and releases disconnected requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-public-"));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const socketPath = join(root, "agent.sock");
  let child: ChildProcess | undefined;
  let upload: ReturnType<typeof request> | undefined;
  try {
    await mkdir(join(root, "codex"));
    await writeFile(join(root, "codex/auth.json"), "{}");
    await writeFile(join(root, "fake-codex"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/public-agent/src/run.ts"],
      {
        env: {
          PATH: process.env.PATH,
          PUBLIC_AGENT_SOCKET: socketPath,
          PUBLIC_AGENT_WORKSPACE: join(root, "workspace"),
          PUBLIC_AGENT_RUNTIME: join(root, "runtime"),
          PUBLIC_CODEX_BINARY: join(root, "fake-codex"),
          CODEX_HOME: join(root, "codex"),
          PUBLIC_AGENT_HEALTH_PORT: String(address.port),
          PUBLIC_AGENT_CONCURRENCY: "1",
          PUBLIC_AGENT_UPLOAD_TIMEOUT_MS: "150",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await once(child.stdout!, "data");
    const readyUrl = `http://127.0.0.1:${address.port}/ready`;
    assert.equal(
      (await fetch(readyUrl)).status,
      503,
      "missing tool host is not ready",
    );
    await writeFile(join(root, "codex-code-mode-host"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    assert.equal((await fetch(readyUrl)).status, 200);
    upload = request({
      socketPath,
      path: "/v1/answer",
      method: "POST",
      headers: { "content-length": "1000" },
    });
    upload.on("error", () => {});
    upload.write("{");
    const health = readyUrl;
    const waitActive = async (expected: number): Promise<void> => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const status = (await (await fetch(health)).json()) as {
          active: number;
        };
        if (status.active === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`Active count did not become ${expected}`);
    };
    await waitActive(1);
    const rejected = await new Promise<number>((resolve, reject) => {
      const req = request(
        { socketPath, path: "/v1/answer", method: "POST" },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end('{"prompt":"test"}');
    });
    assert.equal(rejected, 429);
    upload.destroy();
    await waitActive(0);
    const stalled = request({
      socketPath,
      path: "/v1/answer",
      method: "POST",
      headers: { "content-length": "1000" },
    });
    const expired = new Promise<void>((resolve) =>
      stalled.once("error", () => resolve()),
    );
    stalled.write("{");
    await waitActive(1);
    await expired;
    await waitActive(0);
  } finally {
    upload?.destroy();
    if (child) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("public agent client rejects callback failures, broken streams and total deadline overruns", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-client-"));
  const socketPath = join(root, "agent.sock");
  let mode = "callback";
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write('{"type":"started"}\n');
    if (mode === "broken") {
      res.socket?.destroy();
      return;
    }
    const timer = setInterval(() => res.write(" "), 10);
    res.once("close", () => clearInterval(timer));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(socketPath);
  await once(server, "listening");
  const client = new PublicAgentClient(socketPath, 100);
  try {
    await assert.rejects(
      client.answer("test", () => {
        throw new Error("start receipt failed");
      }),
      /start receipt failed/,
    );
    mode = "broken";
    await assert.rejects(
      client.answer("test", () => {}),
      /aborted|hang up|disconnected/,
    );
    mode = "drip";
    await assert.rejects(
      client.answer("test", () => {}),
      /deadline exceeded/,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("public cancellation escalates when a real child ignores SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "rapi-cancel-"));
  try {
    const binary = join(root, "stubborn");
    const marker = join(root, "ready");
    await writeFile(
      binary,
      `#!${process.execPath}\nconst fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)); process.stdin.resume(); setInterval(()=>{},1000);\n`,
      { mode: 0o755 },
    );
    const controller = new AbortController();
    const execution = runPublicCodex("test", {
      workspace: root,
      runtimeDirectory: root,
      binary,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    const { readFile } = await import("node:fs/promises");
    let pid = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        pid = Number(await readFile(marker, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(pid > 0, "The child installed its SIGTERM handler");
    controller.abort();
    const result = await execution;
    assert.equal(result.reason, "cancel");
    assert.equal(result.ok, false);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
