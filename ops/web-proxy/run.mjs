import { createAllowlistProxy, DEFAULT_ALLOWED_DOMAINS } from "./proxy.mjs";

const port = Number(process.env.WEB_PROXY_PORT ?? "3800");
const clientHost = process.env.WEB_PROXY_CLIENT_HOST ?? "rapi-agent";
const clientPort = Number(process.env.WEB_PROXY_CLIENT_PORT ?? "3800");
const allowedDomains = (process.env.WEB_PROXY_ALLOWED_DOMAINS ?? "")
  .split(",")
  .map((domain) => domain.trim())
  .filter(Boolean);

if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("WEB_PROXY_PORT must be an unprivileged TCP port");
}
if (!Number.isInteger(clientPort) || clientPort < 1024 || clientPort > 65_535) {
  throw new Error("WEB_PROXY_CLIENT_PORT must be an unprivileged TCP port");
}

const server = createAllowlistProxy({
  allowedDomains:
    allowedDomains.length > 0 ? allowedDomains : DEFAULT_ALLOWED_DOMAINS,
  clientHost,
  clientPort,
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`rapi web proxy listening on 127.0.0.1:${port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
