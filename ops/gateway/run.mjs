import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import {
  readWithdrawals,
  filterWithdrawnBlog,
} from "../../scripts/blog-withdrawals.mjs";

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

const server = createServer(async (incoming, outgoing) => {
  const path = incoming.url?.split("?")[0] ?? "";
  if (
    ["GET", "HEAD"].includes(incoming.method) &&
    /^\/blog(?:\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\.html|feed\.xml)?)?$/.test(path)
  ) {
    incoming.resume();
    const name =
      path === "/blog" || path === "/blog/"
        ? "index.html"
        : path.slice("/blog/".length);
    try {
      let body = await readFile(
        new URL(`../../apps/blog/dist/${name}`, import.meta.url),
      );
      const slugs = await readWithdrawals(
        process.env.RAPI_BLOG_WITHDRAWALS_FILE,
        process.env.RAPI_BLOG_WITHDRAWALS_REQUIRED === "true",
      );
      body = filterWithdrawnBlog(name, body, slugs);
      if (!body) {
        respond(outgoing, 404, { error: "not_found" });
        return;
      }
      if (name === "feed.xml" && process.env.RAPI_PUBLIC_BASE_URL) {
        const metadata = JSON.parse(
          await readFile(
            new URL("../../apps/blog/dist/blog-build.json", import.meta.url),
            "utf8",
          ),
        );
        const configured = new URL(process.env.RAPI_PUBLIC_BASE_URL);
        if (!["http:", "https:"].includes(configured.protocol))
          throw new Error("Invalid blog origin");
        const effective = new URL("/blog/", configured.origin).href;
        if (typeof metadata.baseUrl !== "string" || !metadata.baseUrl)
          throw new Error("Blog build origin is missing");
        body = Buffer.from(
          body.toString("utf8").replaceAll(metadata.baseUrl, effective),
        );
      }
      outgoing.writeHead(200, {
        "content-type": name.endsWith(".xml")
          ? "application/rss+xml; charset=utf-8"
          : "text/html; charset=utf-8",
        "cache-control":
          process.env.RAPI_BLOG_WITHDRAWALS_REQUIRED === "true"
            ? "no-store"
            : "public, max-age=60",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src https:; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      outgoing.end(incoming.method === "HEAD" ? undefined : body);
    } catch {
      respond(outgoing, 404, { error: "not_found" });
    }
    return;
  }
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
  process.stdout.write(
    `rapi public gateway listening on 127.0.0.1:${server.address().port}\n`,
  );
});

const healthServer = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    respond(response, 200, { ready: true });
    return;
  }
  if (request.method === "GET" && request.url === "/ready") {
    // An allowlist listener alone does not prove a functioning interaction path.
    void fetch(`http://127.0.0.1:${targetPort}/ready`, {
      signal: AbortSignal.timeout(3000),
    })
      .then(async (upstream) => {
        const body = await upstream.json();
        const ready = upstream.ok && body.ready === true;
        respond(response, ready ? 200 : 503, {
          ready,
          revision: body.revision ?? null,
        });
      })
      .catch(() =>
        respond(response, 503, { ready: false, error: "upstream_unavailable" }),
      );
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
