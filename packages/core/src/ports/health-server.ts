import { createServer, type Server } from "node:http";
import type { ReadinessSummary } from "../domain/health.js";

export function createLocalHealthServer(
  port: number,
  readiness: () => Promise<ReadinessSummary>,
): Server {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && request.url === "/ready") {
      try {
        const body = await readiness();
        response.writeHead(body.ready ? 200 : 503, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(body));
      } catch {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ready: false, error: "unavailable" }));
      }
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(port, "127.0.0.1");
  return server;
}
