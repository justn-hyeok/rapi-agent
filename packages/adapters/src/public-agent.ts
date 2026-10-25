import { request } from "node:http";

/** Reported by the `api` backend only; the codex backend sends none. */
export interface PublicAgentUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 0 with `costSource: "unknown"` means the caller prices the tokens itself. */
  costMicroUsd: number;
  costSource: "gateway" | "unknown";
}

export interface PublicAgentResult {
  started: boolean;
  ok: boolean;
  output: string;
  reason: "exit" | "timeout" | "cancel" | "spawn_error" | "budget";
  usage?: PublicAgentUsage;
}

/** The socket is trusted but not assumed well-formed: anything off becomes "no usage". */
export function parsePublicAgentUsage(
  value: unknown,
): PublicAgentUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const count = (entry: unknown): number | undefined =>
    typeof entry === "number" && Number.isFinite(entry) && entry >= 0
      ? Math.round(entry)
      : undefined;
  const inputTokens = count(raw.inputTokens);
  const outputTokens = count(raw.outputTokens);
  const costMicroUsd = count(raw.costMicroUsd);
  if (
    typeof raw.model !== "string" ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    costMicroUsd === undefined
  )
    return undefined;
  return {
    model: raw.model.slice(0, 100),
    inputTokens,
    outputTokens,
    costMicroUsd,
    costSource: raw.costSource === "gateway" ? "gateway" : "unknown",
  };
}

export class PublicAgentClient {
  constructor(
    readonly socketPath = "/run/rapi-public-agent/agent.sock",
    readonly timeoutMs = 65_000,
  ) {}

  answer(
    prompt: string,
    onStarted: () => Promise<void> | void,
    options?: { feature?: "archive_qa" | "public_qa" },
    signal?: AbortSignal,
  ): Promise<PublicAgentResult> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        prompt,
        ...(options?.feature ? { feature: options.feature } : {}),
      });
      let settled = false;
      const complete = (work: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        work();
      };
      const req = request(
        {
          socketPath: this.socketPath,
          path: "/v1/answer",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
          timeout: this.timeoutMs,
        },
        (response) => {
          let buffered = "";
          let started = false;
          let resultReceived = false;
          let startWork = Promise.resolve();
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            buffered += chunk;
            if (buffered.length > 64_000) {
              complete(() =>
                reject(new Error("Public agent response exceeds the limit")),
              );
              req.destroy();
              return;
            }
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
              if (!line) continue;
              let event:
                | { type: "started" }
                | ({ type: "result" } & PublicAgentResult);
              try {
                event = JSON.parse(line) as typeof event;
              } catch {
                complete(() =>
                  reject(new Error("Invalid public agent response")),
                );
                return;
              }
              if (event.type === "started" && !started) {
                started = true;
                startWork = Promise.resolve().then(onStarted);
                void startWork.catch((error: unknown) => {
                  complete(() =>
                    reject(
                      error instanceof Error
                        ? error
                        : new Error("Public agent start callback failed"),
                    ),
                  );
                  req.destroy();
                });
              } else if (event.type === "result") {
                resultReceived = true;
                void startWork.then(
                  () =>
                    complete(() => {
                      const { usage, ...result } = event as PublicAgentResult;
                      const parsed = parsePublicAgentUsage(usage);
                      resolve(parsed ? { ...result, usage: parsed } : result);
                    }),
                  (error: unknown) =>
                    complete(() =>
                      reject(
                        error instanceof Error
                          ? error
                          : new Error("Public agent start callback failed"),
                      ),
                    ),
                );
              }
            }
          });
          response.once("error", (error) => complete(() => reject(error)));
          response.once("aborted", () =>
            complete(() => reject(new Error("Public agent response aborted"))),
          );
          response.on("end", () => {
            if (resultReceived) return;
            if (response.statusCode !== 200)
              complete(() =>
                reject(
                  new Error(`Public agent returned ${response.statusCode}`),
                ),
              );
            else if (!started)
              complete(() => reject(new Error("Public agent did not start")));
            else
              complete(() =>
                reject(new Error("Public agent disconnected after start")),
              );
          });
        },
      );
      const abort = (): void => {
        req.destroy(new Error("Public agent request cancelled"));
      };
      const deadline = setTimeout(
        () => req.destroy(new Error("Public agent deadline exceeded")),
        this.timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      req.once("timeout", () => req.destroy(new Error("Public agent timeout")));
      req.once("error", (error) => complete(() => reject(error)));
      if (signal?.aborted) {
        abort();
        return;
      }
      req.end(payload);
    });
  }

  readiness(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const req = request(
        {
          socketPath: this.socketPath,
          path: "/ready",
          method: "GET",
          timeout: 3_000,
        },
        (response) => {
          response.resume();
          response.once("end", () => finish(response.statusCode === 200));
        },
      );
      req.once("timeout", () => {
        req.destroy();
        finish(false);
      });
      req.once("error", () => finish(false));
      req.end();
    });
  }
}
