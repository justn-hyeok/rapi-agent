import { specificationSchema, type Specification } from "./specification.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { runChild } from "./process.js";
import { createServer, type ServerResponse } from "node:http";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { redactChat } from "@rapi/contracts";
import { runtimeRevision } from "@rapi/core";
import {
  assertProviderReady,
  buildProviderCommand,
  providerEnvironment,
  providerFailure,
  providerReadiness,
} from "./providers.js";

type Receipt = {
  idempotencyKey: string;
  receiptId: string;
  specification: Specification;
  state: "accepted" | "running" | "completed" | "failed" | "cancelled";
  reason?: string;
  cancelCallbackDelivered?: boolean;
};

const port = Number(process.env.OMP_PORT ?? "3200");
const callbackUrl =
  process.env.OMP_CALLBACK_URL ?? "http://127.0.0.1:3000/omp/callback";
const callbackSecret = process.env.OMP_CALLBACK_SECRET;
const defaultRepository =
  process.env.OMP_DEFAULT_REPOSITORY ?? "/home/justn/rapi-agent";
const workspaceRoot =
  process.env.OMP_WORKSPACE_ROOT ?? "/home/justn/omp-workspaces";
const allowedRoots = (process.env.OMP_ALLOWED_REPOSITORY_ROOTS ?? "/home/justn")
  .split(",")
  .map((entry) => path.resolve(entry.trim()));
const receiptRoot = path.join(workspaceRoot, "receipts");
const receipts = new Map<string, Receipt>();
const running = new Map<
  string,
  { controller: AbortController; done: Promise<void> }
>();

if (!callbackSecret)
  throw new Error("OMP_CALLBACK_SECRET is required to run OMP");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("OMP_PORT must be a valid port");

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > 1_000_000) throw new Error("OMP request exceeds 1 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function receiptPath(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return path.join(receiptRoot, `${digest}.json`);
}

async function saveReceipt(receipt: Receipt): Promise<void> {
  await mkdir(receiptRoot, { recursive: true });
  const target = receiptPath(receipt.idempotencyKey);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await rename(temporary, target);
  receipts.set(receipt.receiptId, receipt);
}

async function loadReceipt(idempotencyKey: string): Promise<Receipt | null> {
  try {
    return JSON.parse(
      await readFile(receiptPath(idempotencyKey), "utf8"),
    ) as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runChild(command, args, {
    ...options,
    env: options.env ?? providerEnvironment(),
  });
}

async function resolveRepository(
  specification: Specification,
): Promise<string> {
  const requested = specification.repository ?? defaultRepository;
  const candidate = path.isAbsolute(requested)
    ? requested
    : path.join(allowedRoots[0]!, requested);
  const repository = await realpath(candidate);
  const allowed = allowedRoots.some((root) => {
    const relative = path.relative(root, repository);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });
  if (!allowed) throw new Error("Repository is outside the configured roots");
  const result = await run("git", [
    "-C",
    repository,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (result.code !== 0) throw new Error("Repository is not a Git worktree");
  return result.stdout.trim();
}

async function sendCallback(
  receipt: Receipt,
  stateVersion: number,
  state: "running" | "completed" | "failed" | "cancelled",
  details: {
    reason?: string;
    resultReportRef?: string;
    evidenceRefs?: string[];
  } = {},
): Promise<void> {
  const body = Buffer.from(
    JSON.stringify({
      callback_event_id: `${receipt.receiptId}:${stateVersion}`,
      receipt_id: receipt.receiptId,
      execution_attempt_id: receipt.specification.execution_attempt_id,
      state_version: stateVersion,
      state,
      occurred_at: new Date().toISOString(),
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.resultReportRef
        ? { result_report_ref: details.resultReportRef }
        : {}),
      evidence_refs: details.evidenceRefs ?? [],
      key_id: "local-omp-v1",
      signature: "x-omp-signature",
    }),
  );
  const signature = createHmac("sha256", callbackSecret!)
    .update(body)
    .digest("hex");
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omp-signature": signature,
        },
        body,
      });
      lastStatus = response.status;
      await response.arrayBuffer();
      if (response.ok) {
        if (state === "cancelled") {
          receipt.cancelCallbackDelivered = true;
          await saveReceipt(receipt);
        }
        return;
      }
    } catch {
      // The bot may be restarting; retry the signed callback.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`OMP callback failed with status ${lastStatus}`);
}

function promptFor(specification: Specification): string {
  return [
    "Execute the approved development task below in the current isolated Git clone.",
    "Stay inside this clone and do not read application secrets.",
    `Approved permissions: ${JSON.stringify(specification.permissions)}.`,
    "Do not commit, push, create a pull request, or deploy unless that exact permission is approved.",
    "If commit:create is approved, create a focused commit after the checks pass.",
    "Run the acceptance checks and report changed files, commands run, test results, and remaining limitations.",
    "Task specification:",
    JSON.stringify(specification, null, 2),
  ].join("\n\n");
}

async function execute(receipt: Receipt, signal: AbortSignal): Promise<void> {
  receipt.state = "running";
  const specification = specificationSchema.parse(receipt.specification);
  let workspace = "";
  let reportPath = "";
  try {
    await saveReceipt(receipt);
    await sendCallback(receipt, 1, "running");
    await assertProviderReady(specification.provider);
    signal.throwIfAborted();
    const repository = await resolveRepository(specification);
    workspace = path.join(
      workspaceRoot,
      specification.execution_attempt_id.replaceAll(/[^a-zA-Z0-9_.-]/g, "_"),
    );
    reportPath = path.join(workspace, "omp-result.md");
    try {
      await access(path.join(workspace, ".git"));
    } catch {
      await mkdir(workspaceRoot, { recursive: true });
      const branch = `omp/${specification.execution_attempt_id}`;
      const clone = await run(
        "git",
        ["clone", "--no-checkout", repository, workspace],
        { signal },
      );
      if (clone.code !== 0)
        throw new Error(clone.stderr.trim() || "Could not clone repository");
      const checkout = await run(
        "git",
        [
          "-C",
          workspace,
          "checkout",
          "-b",
          branch,
          specification.base_revision,
        ],
        { signal },
      );
      if (checkout.code !== 0)
        throw new Error(checkout.stderr.trim() || "Could not create branch");
      const remote = await run("git", [
        "-C",
        repository,
        "remote",
        "get-url",
        "origin",
      ]);
      if (remote.code === 0 && remote.stdout.trim()) {
        const setRemote = await run("git", [
          "-C",
          workspace,
          "remote",
          "set-url",
          "origin",
          remote.stdout.trim(),
        ]);
        if (setRemote.code !== 0)
          throw new Error(setRemote.stderr.trim() || "Could not set remote");
      }
    }

    const initialRevision = await run("git", [
      "-C",
      workspace,
      "rev-parse",
      "HEAD",
    ]);
    const command = buildProviderCommand(
      specification,
      workspace,
      reportPath,
      promptFor(specification),
    );
    const result = await run(command.command, command.args, {
      cwd: workspace,
      ...(command.input === undefined ? {} : { input: command.input }),
      timeoutMs: specification.timeout_seconds * 1000,
      env: providerEnvironment(specification.provider),
      signal,
    });
    const logPath = path.join(workspace, "omp-execution.log");
    await writeFile(logPath, redactChat(`${result.stdout}\n${result.stderr}`), {
      mode: 0o600,
    });
    if (command.stdoutReport) {
      await writeFile(reportPath, redactChat(result.stdout), { mode: 0o600 });
    } else {
      try {
        await writeFile(
          reportPath,
          redactChat(await readFile(reportPath, "utf8")),
          { mode: 0o600 },
        );
      } catch (error) {
        if (result.code === 0) throw error;
      }
    }
    signal.throwIfAborted();
    if (result.code !== 0)
      throw new Error(providerFailure(specification.provider, result.code));

    let revision = await run("git", ["-C", workspace, "rev-parse", "HEAD"]);
    if (
      !specification.permissions.includes("commit:create") &&
      revision.stdout.trim() !== initialRevision.stdout.trim()
    ) {
      const reset = await run("git", [
        "-C",
        workspace,
        "reset",
        "--mixed",
        initialRevision.stdout.trim(),
      ]);
      if (reset.code !== 0)
        throw new Error(
          reset.stderr.trim() || "Could not remove unapproved commit",
        );
      revision = await run("git", ["-C", workspace, "rev-parse", "HEAD"]);
    }
    const status = await run("git", ["-C", workspace, "status", "--short"]);
    const evidencePath = path.join(workspace, "omp-evidence.json");
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          repository,
          workspace,
          revision: revision.stdout.trim(),
          status: status.stdout.trim().split("\n").filter(Boolean),
          permissions: specification.permissions,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    receipt.state = "completed";
    await saveReceipt(receipt);
    await sendCallback(receipt, 2, "completed", {
      resultReportRef: reportPath,
      evidenceRefs: [
        `workspace:${workspace}`,
        `revision:${revision.stdout.trim()}`,
        `evidence:${evidencePath}`,
        `log:${logPath}`,
      ],
    });
  } catch (error) {
    const reason = redactChat(
      error instanceof Error ? error.message : "OMP execution failed",
    );
    receipt.state = signal.aborted ? "cancelled" : "failed";
    receipt.reason = signal.aborted ? "Process termination confirmed" : reason;
    await saveReceipt(receipt);
    try {
      await sendCallback(receipt, 2, receipt.state, {
        reason: receipt.reason,
        ...(reportPath ? { resultReportRef: reportPath } : {}),
        evidenceRefs: workspace ? [`workspace:${workspace}`] : [],
      });
    } catch (callbackError) {
      process.stderr.write(
        `${redactChat(callbackError instanceof Error ? callbackError.message : "Callback failed")}\n`,
      );
    }
  }
}

await mkdir(receiptRoot, { recursive: true });
function start(receipt: Receipt): void {
  if (running.has(receipt.receiptId) || receipt.state === "cancelled") return;
  const active = { controller: new AbortController(), done: Promise.resolve() };
  running.set(receipt.receiptId, active);
  active.done = execute(receipt, active.controller.signal).finally(() =>
    running.delete(receipt.receiptId),
  );
  void active.done.catch(() => undefined);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health")
      return json(response, 200, { status: "ok" });
    if (request.method === "GET" && request.url === "/ready") {
      const providers = Object.fromEntries(
        await Promise.all(
          (["codex", "cursor", "commandcode"] as const).map(
            async (provider) =>
              [provider, await providerReadiness(provider)] as const,
          ),
        ),
      );
      const ready = Object.values(providers).some(
        (provider) => provider.binary && provider.configured,
      );
      return json(response, ready ? 200 : 503, {
        ready,
        revision: runtimeRevision,
        checkedAt: new Date().toISOString(),
        executor: "omp",
        providers,
        running: running.size,
      });
    }
    if (request.method === "POST" && request.url === "/cancel") {
      const input = JSON.parse((await readBody(request)).toString("utf8")) as {
        receipt_id?: string;
        execution_attempt_id?: string;
      };
      const receipt = input.receipt_id
        ? receipts.get(input.receipt_id)
        : undefined;
      if (
        !receipt ||
        receipt.specification.execution_attempt_id !==
          input.execution_attempt_id
      )
        return json(response, 404, { reason: "Execution receipt not found" });
      const active = running.get(receipt.receiptId);
      if (active) {
        active.controller.abort();
        await active.done;
      } else if (receipt.state === "accepted") {
        receipt.state = "cancelled";
        await saveReceipt(receipt);
      }
      if (receipt.state === "cancelled" && !receipt.cancelCallbackDelivered)
        await sendCallback(receipt, 2, "cancelled", {
          reason: receipt.reason ?? "Process termination confirmed",
        });
      return json(response, 200, {
        cancelled: receipt.state === "cancelled",
        state: receipt.state,
      });
    }
    if (request.method !== "POST" || request.url !== "/dispatch")
      return json(response, 404, { error: "not found" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey)
      return json(response, 400, { reason: "idempotency-key is required" });
    const existing = await loadReceipt(idempotencyKey);
    if (existing)
      return json(response, 200, {
        receipt_id: existing.receiptId,
        accepted: !["failed", "cancelled"].includes(existing.state),
        ...(existing.state === "cancelled"
          ? { reason: "Execution was cancelled" }
          : {}),
      });
    const parsed = specificationSchema.safeParse(
      JSON.parse((await readBody(request)).toString("utf8")),
    );
    if (!parsed.success)
      return json(response, 400, {
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    if (new Date(parsed.data.approval_expires_at) <= new Date())
      return json(response, 400, { reason: "Approval has expired" });
    const receipt: Receipt = {
      idempotencyKey,
      receiptId: randomUUID(),
      specification: parsed.data,
      state: "accepted",
    };
    await saveReceipt(receipt);
    response.once("finish", () => start(receipt));
    return json(response, 202, {
      receipt_id: receipt.receiptId,
      accepted: true,
    });
  } catch (error) {
    return json(response, 500, {
      reason: redactChat(
        error instanceof Error ? error.message : "OMP request failed",
      ),
    });
  }
});

for (const file of await readdir(receiptRoot)) {
  if (!file.endsWith(".json")) continue;
  try {
    const receipt = JSON.parse(
      await readFile(path.join(receiptRoot, file), "utf8"),
    ) as Receipt;
    receipts.set(receipt.receiptId, receipt);
    if (receipt.state === "accepted" || receipt.state === "running")
      start(receipt);
    else if (receipt.state === "cancelled" && !receipt.cancelCallbackDelivered)
      void sendCallback(receipt, 2, "cancelled", {
        reason: receipt.reason ?? "Cancelled before execution",
      }).catch(() =>
        process.stderr.write("Could not reconcile cancelled execution\n"),
      );
  } catch (error) {
    process.stderr.write(
      `Could not resume ${file}: ${redactChat(error instanceof Error ? error.message : "invalid receipt")}\n`,
    );
  }
}

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`rapi-omp listening on 127.0.0.1:${port}\n`);
});

const shutdown = (): void => {
  for (const active of running.values()) active.controller.abort();
  server.close(() => {
    void Promise.allSettled(
      [...running.values()].map((active) => active.done),
    ).then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
