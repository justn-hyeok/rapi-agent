import { spawn } from "node:child_process";

export async function runChild(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw new Error("Execution cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let stopping = false;
    let failure: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Process close, rather than a guessed PID, is the completion signal.
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 1_000);
    };
    const collect = (chunk: Buffer, kind: "stdout" | "stderr") => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        failure = new Error("Execution output exceeds 1 MB");
        stop();
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      failure = error;
    });
    const timeout = setTimeout(() => {
      failure = new Error("Execution timed out");
      stop();
    }, options.timeoutMs ?? 30_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", stop);
      kill("SIGKILL");
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}
