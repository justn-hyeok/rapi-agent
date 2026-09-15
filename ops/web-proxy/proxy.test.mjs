import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import {
  createAllowlistProxy,
  isAllowedHost,
  isPublicAddress,
  parseConnectTarget,
} from "./proxy.mjs";

test("allowlist accepts required hosts and their subdomains", () => {
  assert.equal(isAllowedHost("api.deepseek.com"), true);
  assert.equal(isAllowedHost("m.comic.naver.com"), true);
  assert.equal(isAllowedHost("gall.dcinside.com"), true);
  assert.equal(isAllowedHost("example.com"), false);
  assert.equal(isAllowedHost("deepseek.com.example.com"), false);
  assert.equal(isAllowedHost("127.0.0.1"), false);
});

test("CONNECT only permits a domain on TLS port 443", () => {
  assert.deepEqual(parseConnectTarget("api.deepseek.com:443"), {
    host: "api.deepseek.com",
    port: 443,
  });
  assert.equal(parseConnectTarget("api.deepseek.com:22"), null);
  assert.equal(parseConnectTarget("127.0.0.1:443"), null);
});

test("private and reserved addresses are rejected", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("local PAC routes allowed domains and leaves other traffic direct", async (t) => {
  const server = createAllowlistProxy({
    clientHost: "rapi-agent",
    clientPort: 3800,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/proxy.pac",
        headers: { host: "rapi-agent:3800" },
      },
      resolve,
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
  let body = "";
  response.setEncoding("utf8");
  for await (const chunk of response) body += chunk;
  assert.equal(response.statusCode, 200);
  assert.match(body, /deepseek\.com/);
  assert.match(body, /PROXY rapi-agent:3800/);
  assert.match(body, /return "DIRECT"/);
});
