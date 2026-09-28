import { request } from "node:http";

export interface PublicAgentResult {
  started: boolean;
  ok: boolean;
  output: string;
  reason: "exit" | "timeout" | "cancel" | "spawn_error";
}

export class PublicAgentClient {
  constructor(
    readonly socketPath = "/run/rapi-public-agent/agent.sock",
    readonly timeoutMs = 65_000,
  ) {}

  answer(
    prompt: string,
    onStarted: () => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<PublicAgentResult> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ prompt });
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
                  () => complete(() => resolve(event as PublicAgentResult)),
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
