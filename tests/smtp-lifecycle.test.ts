import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import { test } from "node:test";
import {
  PermanentDeliveryError,
  SmtpDeliveryAdapter,
  UncertainDeliveryError,
} from "@rapi/adapters";

test("SMTP terminates on silence/close and classifies accepted, rejected and uncertain DATA", async () => {
  const root = mkdtempSync(join(tmpdir(), "rapi-smtp-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(root, "key.pem"),
        "-out",
        join(root, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    for (const mode of [
      "silent",
      "closed",
      "temporary",
      "permanent",
      "uncertain",
      "accepted",
    ] as const) {
      const sockets = new Set<import("node:tls").TLSSocket>();
      const server = createServer(
        {
          key: readFileSync(join(root, "key.pem")),
          cert: readFileSync(join(root, "cert.pem")),
        },
        (socket) => {
          sockets.add(socket);
          socket.on("error", () => {});
          socket.on("close", () => sockets.delete(socket));
          if (mode === "closed") {
            socket.destroy();
            return;
          }
          if (mode === "silent") return;
          socket.write("220 hello\r\n");
          let buffer = "";
          let auth = 0;
          let data = false;
          socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            if (data) {
              if (!buffer.includes("\r\n.\r\n")) return;
              if (mode === "uncertain") socket.destroy();
              else if (mode === "accepted") socket.end("250 accepted\r\n");
              else
                socket.write(
                  `${mode === "permanent" ? 550 : 451} rejected\r\n`,
                );
              buffer = "";
              return;
            }
            while (buffer.includes("\r\n")) {
              const index = buffer.indexOf("\r\n");
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              if (line.startsWith("EHLO"))
                socket.write("250-test\r\n250 OK\r\n");
              else if (line === "AUTH LOGIN") {
                auth = 1;
                socket.write("334 username\r\n");
              } else if (auth === 1) {
                auth = 2;
                socket.write("334 password\r\n");
              } else if (auth === 2) {
                auth = 0;
                socket.write("235 authenticated\r\n");
              } else if (line === "DATA") {
                data = true;
                socket.write("354 continue\r\n");
              } else socket.write("250 OK\r\n");
            }
          });
        },
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const adapter = new SmtpDeliveryAdapter(
        {
          host: "127.0.0.1",
          servername: "localhost",
          port: address.port,
          username: "test",
          password: "test",
          from: "sender@example.invalid",
          timeoutMs: 300,
        },
        (options) => connect({ ...options, rejectUnauthorized: false }),
      );
      const send = () =>
        adapter.send(
          { channel: "email", recipientId: "recipient@example.invalid" },
          {
            subject: "Briefing",
            text: "hello",
            html: "<p>hello</p>",
            itemIds: [],
          },
          "test-batch",
        );
      try {
        if (mode === "accepted")
          assert.equal(
            (await send()).providerId,
            "<test-batch@rapi-agent.local>",
          );
        else if (mode === "uncertain")
          await assert.rejects(send(), UncertainDeliveryError);
        else if (mode === "permanent")
          await assert.rejects(send(), PermanentDeliveryError);
        else if (mode === "temporary")
          await assert.rejects(
            send(),
            (error: unknown) =>
              error instanceof Error &&
              !(error instanceof PermanentDeliveryError) &&
              !(error instanceof UncertainDeliveryError) &&
              /451/.test(error.message),
          );
        else await assert.rejects(send(), /timed out|closed|ended|socket/i);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
