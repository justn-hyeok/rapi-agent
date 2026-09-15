import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { connect as tcpConnect } from "node:net";
import { domainToASCII, URL } from "node:url";

export const DEFAULT_ALLOWED_DOMAINS = Object.freeze([
  "deepseek.com",
  "dcinside.com",
  "dcinside.co.kr",
  "comic.naver.com",
  "game.naver.com",
  "nid.naver.com",
  "pstatic.net",
  "naver.net",
  "challenges.cloudflare.com",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function normalizeHost(value) {
  const host = domainToASCII(value.trim().toLowerCase().replace(/\.$/, ""));
  if (!host || isIP(host) !== 0 || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

export function isAllowedHost(value, allowedDomains = DEFAULT_ALLOWED_DOMAINS) {
  const host = normalizeHost(value);
  if (!host) return false;
  return allowedDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const [a = -1, b = -1, c = -1] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const mappedV4 = normalized.match(/:((?:\d{1,3}\.){3}\d{1,3})$/)?.[1];
    if (mappedV4) return isPublicAddress(mappedV4);
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return false;
}

export function parseConnectTarget(authority) {
  const match = /^([^:\s/]+)(?::(\d{1,5}))?$/.exec(authority ?? "");
  if (!match) return null;
  const host = normalizeHost(match[1] ?? "");
  const port = Number(match[2] ?? "443");
  if (!host || port !== 443) return null;
  return { host, port };
}

function filteredHeaders(headers, host) {
  const result = { host };
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name !== "host") {
      result[name] = value;
    }
  }
  result.connection = "close";
  return result;
}

async function resolvePublic(host, lookup = dnsLookup) {
  const answers = await lookup(host, { all: true, verbatim: true });
  const answer = answers.find(({ address }) => isPublicAddress(address));
  if (!answer)
    throw new Error("destination did not resolve to a public address");
  return answer;
}

function pacScript(allowedDomains, clientHost, clientPort) {
  const conditions = allowedDomains
    .map(
      (domain) =>
        `host === ${JSON.stringify(domain)} || dnsDomainIs(host, ${JSON.stringify(`.${domain}`)})`,
    )
    .join(" ||\n      ");
  return `function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (
      ${conditions}
  ) return "PROXY ${clientHost}:${clientPort}";
  return "DIRECT";
}\n`;
}

function respond(
  response,
  status,
  body,
  contentType = "text/plain; charset=utf-8",
) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function createAllowlistProxy({
  allowedDomains = DEFAULT_ALLOWED_DOMAINS,
  clientHost = "127.0.0.1",
  clientPort = 18_080,
  lookup = dnsLookup,
} = {}) {
  const normalizedDomains = allowedDomains.map(normalizeHost);
  if (normalizedDomains.some((domain) => domain === null)) {
    throw new Error("WEB_PROXY_ALLOWED_DOMAINS contains an invalid domain");
  }
  const domains = normalizedDomains;

  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url === "/proxy.pac") {
      respond(
        outgoing,
        200,
        pacScript(domains, clientHost, clientPort),
        "application/x-ns-proxy-autoconfig",
      );
      return;
    }
    if (incoming.method === "GET" && incoming.url === "/health") {
      respond(
        outgoing,
        200,
        JSON.stringify({ ready: true }),
        "application/json",
      );
      return;
    }

    let destination;
    try {
      destination = new URL(incoming.url ?? "");
    } catch {
      incoming.resume();
      respond(outgoing, 400, "A forward-proxy URL is required.\n");
      return;
    }
    const host = normalizeHost(destination.hostname);
    const port = Number(destination.port || "80");
    if (
      destination.protocol !== "http:" ||
      destination.username ||
      destination.password ||
      !host ||
      port !== 80 ||
      !isAllowedHost(host, domains)
    ) {
      incoming.resume();
      respond(outgoing, 403, "Destination is not allowed.\n");
      return;
    }

    try {
      const resolved = await resolvePublic(host, lookup);
      const upstream = httpRequest(
        {
          host: resolved.address,
          family: resolved.family,
          port,
          method: incoming.method,
          path: `${destination.pathname}${destination.search}`,
          headers: filteredHeaders(incoming.headers, destination.host),
          timeout: 30_000,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("timeout", () =>
        upstream.destroy(new Error("upstream timeout")),
      );
      upstream.on("error", () => {
        if (!outgoing.headersSent)
          respond(outgoing, 502, "Upstream unavailable.\n");
        else outgoing.destroy();
      });
      incoming.on("aborted", () => upstream.destroy());
      incoming.pipe(upstream);
    } catch {
      incoming.resume();
      respond(outgoing, 502, "Destination resolution failed.\n");
    }
  });

  server.on("connect", (incoming, client, head) => {
    void (async () => {
      const target = parseConnectTarget(incoming.url);
      if (!target || !isAllowedHost(target.host, domains)) {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      try {
        const resolved = await resolvePublic(target.host, lookup);
        const upstream = tcpConnect({
          host: resolved.address,
          family: resolved.family,
          port: target.port,
        });
        upstream.setTimeout(10 * 60_000, () => upstream.destroy());
        upstream.once("connect", () => {
          client.write(
            "HTTP/1.1 200 Connection Established\r\nProxy-Agent: rapi-allowlist\r\n\r\n",
          );
          if (head.length > 0) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => {
          if (!client.destroyed) {
            client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
          }
        });
        client.on("error", () => upstream.destroy());
      } catch {
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    })();
  });

  return server;
}
