import { createServer, request as httpRequest } from "node:http";

const port = Number(process.env.RAPI_GATEWAY_PORT ?? "3600");
const healthPort = Number(process.env.RAPI_GATEWAY_HEALTH_PORT ?? "3601");
const targetPort = Number(process.env.PORT ?? "3000");
const allowed = [
  /^\/interactions$/,
  /^\/webhooks\/v1\/[^/?#]+$/,
  /^\/webhooks\/[^/?#]+$/,
];

function respond(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const server = createServer((incoming, outgoing) => {
  const path = incoming.url?.split("?")[0] ?? "";
  if (incoming.method !== "POST" || !allowed.some((rule) => rule.test(path))) {
    incoming.resume();
    respond(outgoing, 404, { error: "not_found" });
    return;
  }
  const headers = { ...incoming.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["proxy-authorization"];
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: targetPort,
      method: "POST",
      path: incoming.url,
      headers: { ...headers, host: `127.0.0.1:${targetPort}` },
      timeout: 65_000,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!outgoing.headersSent)
      respond(outgoing, 502, { error: "upstream_unavailable" });
    else outgoing.destroy();
  });
  incoming.pipe(upstream);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`rapi public gateway listening on 127.0.0.1:${port}\n`);
});

const healthServer = createServer((request, response) => {
  if (request.method === "GET" && ["/health", "/ready"].includes(request.url)) {
    respond(response, 200, { ready: true });
    return;
  }
  respond(response, 404, { error: "not_found" });
});
healthServer.listen(healthPort, "127.0.0.1");

const shutdown = () => {
  healthServer.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
