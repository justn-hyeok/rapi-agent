import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
import { z } from "zod";

const permissionSchema = z.enum([
  "repo:read",
  "repo:write",
  "commit:create",
  "push",
  "pull_request:create",
  "deploy",
]);

const specificationSchema = z
  .object({
    task_id: z.string().min(1),
    task_revision: z.number().int().positive(),
    execution_attempt_id: z.string().min(1),
    approval_id: z.string().min(1),
    approval_expires_at: z.string().datetime({ offset: true }),
    workspace_ref: z.string().min(1),
    goal: z.string().min(1),
    repository: z.string().min(1).optional(),
    base_revision: z.string().min(1).default("HEAD"),
    non_goals: z.array(z.string()).default([]),
    requirements: z.array(z.string()).default([]),
    acceptance_criteria: z.array(z.string()).default([]),
    permissions: z.array(permissionSchema).default([]),
    forbidden_actions: z.array(z.string()).default([]),
    timeout_seconds: z.number().int().min(30).max(7200).default(1800),
  })
  .passthrough();

type Specification = z.infer<typeof specificationSchema>;
type Receipt = {
  idempotencyKey: string;
  receiptId: string;
  specification: Specification;
  state: "accepted" | "running" | "completed" | "failed";
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
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
      : undefined;
    timer?.unref();
    child.once("close", () => {
      if (timer) clearTimeout(timer);
    });
    child.stdin.end(options.input);
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

function codexEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const upper = key.toUpperCase();
      return !(
        upper.includes("TOKEN") ||
        upper.includes("SECRET") ||
        upper.includes("PASSWORD") ||
        upper.includes("API_KEY") ||
        upper === "DATABASE_URL"
      );
    }),
  );
}

async function sendCallback(
  receipt: Receipt,
  stateVersion: number,
  state: "running" | "completed" | "failed",
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
      if (response.ok) return;
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
    "Run the acceptance checks and report changed files, commands run, test results, and remaining limitations.",
    "Task specification:",
    JSON.stringify(specification, null, 2),
  ].join("\n\n");
}

async function execute(receipt: Receipt): Promise<void> {
  receipt.state = "running";
  await saveReceipt(receipt);
  await sendCallback(receipt, 1, "running");
  const specification = receipt.specification;
  let workspace = "";
  let reportPath = "";
  try {
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
      const clone = await run("git", [
        "clone",
        "--no-checkout",
        repository,
        workspace,
      ]);
      if (clone.code !== 0)
        throw new Error(clone.stderr.trim() || "Could not clone repository");
      const checkout = await run("git", [
        "-C",
        workspace,
        "checkout",
        "-b",
        branch,
        specification.base_revision,
      ]);
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
    const sandboxArguments = specification.permissions.includes("repo:write")
      ? ["--approve-for-me"]
      : ["--sandbox", "read-only"];
    const codex = await run(
      "/usr/local/bin/codex",
      [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        ...sandboxArguments,
        "--color",
        "never",
        "--output-last-message",
        reportPath,
        "-C",
        workspace,
        "-",
      ],
      {
        cwd: workspace,
        input: promptFor(specification),
        timeoutMs: specification.timeout_seconds * 1000,
        env: codexEnvironment(),
      },
    );
    const logPath = path.join(workspace, "omp-execution.log");
    await writeFile(logPath, `${codex.stdout}\n${codex.stderr}`, {
      mode: 0o600,
    });
    if (codex.code !== 0)
      throw new Error(`Codex exited with status ${codex.code}`);

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
    const reason =
      error instanceof Error ? error.message : "OMP execution failed";
    receipt.state = "failed";
    await saveReceipt(receipt);
    try {
      await sendCallback(receipt, 2, "failed", {
        reason,
        ...(reportPath ? { resultReportRef: reportPath } : {}),
        evidenceRefs: workspace ? [`workspace:${workspace}`] : [],
      });
    } catch (callbackError) {
      process.stderr.write(
        `${callbackError instanceof Error ? callbackError.message : "Callback failed"}\n`,
      );
    }
  }
}

await mkdir(receiptRoot, { recursive: true });
const running = new Set<string>();

function start(receipt: Receipt): void {
  if (running.has(receipt.receiptId)) return;
  running.add(receipt.receiptId);
  void execute(receipt).finally(() => running.delete(receipt.receiptId));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health")
      return json(response, 200, { status: "ok", executor: "codex" });
    if (request.method !== "POST" || request.url !== "/dispatch")
      return json(response, 404, { error: "not found" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey)
      return json(response, 400, { reason: "idempotency-key is required" });
    const existing = await loadReceipt(idempotencyKey);
    if (existing)
      return json(response, 200, {
        receipt_id: existing.receiptId,
        accepted: existing.state !== "failed",
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
      reason: error instanceof Error ? error.message : "OMP request failed",
    });
  }
});

for (const file of await readdir(receiptRoot)) {
  if (!file.endsWith(".json")) continue;
  try {
    const receipt = JSON.parse(
      await readFile(path.join(receiptRoot, file), "utf8"),
    ) as Receipt;
    if (receipt.state === "accepted" || receipt.state === "running")
      start(receipt);
  } catch (error) {
    process.stderr.write(
      `Could not resume ${file}: ${error instanceof Error ? error.message : "invalid receipt"}\n`,
    );
  }
}

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`rapi-omp listening on 127.0.0.1:${port}\n`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
