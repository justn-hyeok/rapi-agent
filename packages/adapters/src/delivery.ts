import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  connect as tlsConnect,
  type ConnectionOptions,
  type TLSSocket,
} from "node:tls";
import { parseDocument } from "yaml";
import type {
  DeliveryAdapter,
  DeliveryPayload,
  DeliveryResult,
  DeliveryTarget,
} from "@rapi/core";
import { splitDiscordMessage } from "@rapi/core";

export class UncertainDeliveryError extends Error {
  readonly possiblyDelivered = true;
}

export class PermanentDeliveryError extends Error {}

class SmtpResponseError extends Error {
  constructor(readonly code: number) {
    super(`SMTP returned ${code}`);
  }
}

export class DiscordDeliveryAdapter implements DeliveryAdapter {
  constructor(private readonly botToken: string) {}

  async send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
  ): Promise<DeliveryResult> {
    let channelId = target.recipientId;
    if (target.channel === "discord_dm") {
      const dm = await this.request("/users/@me/channels", {
        recipient_id: target.recipientId,
      });
      channelId = String(dm.id);
    }
    if (
      target.channel !== "discord_dm" &&
      target.channel !== "discord_channel"
    ) {
      throw new Error("Discord adapter received a non-Discord target");
    }
    let providerId = "";
    for (const content of splitDiscordMessage(payload.text)) {
      try {
        const message = await this.request(`/channels/${channelId}/messages`, {
          content,
          allowed_mentions: { parse: [] },
        });
        providerId = String(message.id);
      } catch (error) {
        if (providerId && !(error instanceof UncertainDeliveryError))
          throw new UncertainDeliveryError(
            "Discord delivery was partially accepted",
            { cause: error },
          );
        throw error;
      }
    }
    return { providerId };
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`https://discord.com/api/v10${path}`, {
        method: "POST",
        headers: {
          authorization: `Bot ${this.botToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (/^\/channels\/[^/]+\/messages$/.test(path))
        throw new UncertainDeliveryError(
          "Discord message delivery outcome is uncertain",
          { cause: error },
        );
      throw error;
    }
    if (!response.ok) throw new Error(`Discord returned ${response.status}`);
    try {
      const message = (await response.json()) as Record<string, unknown>;
      if (typeof message.id !== "string" || !message.id)
        throw new Error("Discord response has no message identity");
      return message;
    } catch (error) {
      if (/^\/channels\/[^/]+\/messages$/.test(path))
        throw new UncertainDeliveryError(
          "Discord delivery acknowledgement is uncertain",
          { cause: error },
        );
      throw error;
    }
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  servername?: string;
  timeoutMs?: number;
}

function safeHeader(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Email header contains a newline");
  return value;
}

function createResponseReader(
  socket: TLSSocket,
  timeoutMs: number,
): () => Promise<string> {
  let buffer = "";
  let terminalError: Error | undefined;
  const waiting: Array<{
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const responses: string[] = [];
  const fail = (error: Error): void => {
    terminalError ??= error;
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(terminalError);
    }
  };
  socket.on("error", fail);
  socket.on("end", () => fail(new Error("SMTP connection ended")));
  socket.on("close", () => fail(new Error("SMTP connection closed")));
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 65_536 || responses.length > 100) {
      fail(new Error("SMTP response exceeds the limit"));
      socket.destroy();
      return;
    }
    const lines = buffer.split("\r\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!/^\d{3} /.test(line)) continue;
      const waiter = waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else responses.push(line);
    }
  });
  return () => {
    if (terminalError) return Promise.reject(terminalError);
    const ready = responses.shift();
    return ready
      ? Promise.resolve(ready)
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            fail(new Error("SMTP response timed out"));
            socket.destroy();
          }, timeoutMs);
          waiting.push({ resolve, reject, timer });
        });
  };
}

export class SmtpDeliveryAdapter implements DeliveryAdapter {
  constructor(
    private readonly options: SmtpOptions,
    private readonly connect: (
      options: ConnectionOptions,
    ) => TLSSocket = tlsConnect,
  ) {}

  async send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
    idempotencyKey: string,
  ): Promise<DeliveryResult> {
    if (target.channel !== "email")
      throw new Error("SMTP adapter received a non-email target");
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("SMTP timeout must be a positive integer");
    // Validate every header before connecting or entering the DATA phase.
    for (const value of [
      this.options.from,
      target.recipientId,
      payload.subject,
      idempotencyKey,
      this.options.servername ?? "rapi-agent",
    ])
      safeHeader(value);
    const socket = this.connect({
      host: this.options.host,
      port: this.options.port,
      servername: this.options.servername ?? this.options.host,
    });
    const readResponse = createResponseReader(socket, timeoutMs);
    const command = async (value: string, expected: number): Promise<void> => {
      socket.write(`${value}\r\n`);
      const response = await readResponse();
      const code = Number(response.slice(0, 3));
      if (code !== expected) throw new SmtpResponseError(code);
    };
    let dataSubmitted = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("SMTP TLS connection timed out"));
        }, timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          socket.off("secureConnect", connected);
          socket.off("error", failed);
          socket.off("close", closed);
        };
        const connected = (): void => {
          cleanup();
          resolve();
        };
        const failed = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const closed = (): void => failed(new Error("SMTP connection closed"));
        socket.once("secureConnect", connected);
        socket.once("error", failed);
        socket.once("close", closed);
      });
      const greeting = await readResponse();
      if (!greeting.startsWith("220"))
        throw new SmtpResponseError(Number(greeting.slice(0, 3)));
      await command(
        `EHLO ${safeHeader(this.options.servername ?? "rapi-agent")}`,
        250,
      );
      await command("AUTH LOGIN", 334);
      await command(Buffer.from(this.options.username).toString("base64"), 334);
      await command(Buffer.from(this.options.password).toString("base64"), 235);
      await command(`MAIL FROM:<${safeHeader(this.options.from)}>`, 250);
      await command(`RCPT TO:<${safeHeader(target.recipientId)}>`, 250);
      await command("DATA", 354);
      const boundary = `rapi-${randomUUID()}`;
      // Delivery keys contain colons and recipient addresses, which are not
      // valid dot-atom Message-ID local parts. Keep correlation deterministic.
      const messageId = `<${createHash("sha256").update(idempotencyKey).digest("hex")}@rapi-agent.local>`;
      const message = [
        `From: ${safeHeader(this.options.from)}`,
        `To: ${safeHeader(target.recipientId)}`,
        `Subject: ${safeHeader(payload.subject)}`,
        `Message-ID: ${messageId}`,
        `Date: ${new Date().toUTCString()}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        payload.text,
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        payload.html,
        `--${boundary}--`,
        "",
      ]
        .join("\r\n")
        .replace(/^\./gm, "..");
      dataSubmitted = true;
      await command(`${message}\r\n.`, 250);
      // DATA's 250 is the receipt. Losing QUIT cannot turn acceptance into a retry.
      socket.end("QUIT\r\n");
      return { providerId: messageId };
    } catch (error) {
      if (error instanceof SmtpResponseError) {
        if (error.code >= 500 && error.code <= 599)
          throw new PermanentDeliveryError(error.message, { cause: error });
        throw error;
      }
      if (dataSubmitted)
        throw new UncertainDeliveryError("SMTP delivery outcome is uncertain", {
          cause: error,
        });
      throw error;
    } finally {
      socket.destroy();
    }
  }
}

export interface RecordedDelivery {
  target: DeliveryTarget;
  payload: DeliveryPayload;
  idempotencyKey: string;
}

export class MemoryDeliveryAdapter implements DeliveryAdapter {
  readonly deliveries: RecordedDelivery[] = [];
  readonly failures = new Set<string>();

  async send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
    idempotencyKey: string,
  ): Promise<DeliveryResult> {
    if (this.failures.has(`${target.channel}:${target.recipientId}`))
      throw new Error("Injected delivery failure");
    this.deliveries.push({ target, payload, idempotencyKey });
    return Promise.resolve({ providerId: `memory:${idempotencyKey}` });
  }
}

export class MdxPublisher {
  constructor(
    private readonly contentDirectory: string,
    private readonly publicDirectory: string,
  ) {}

  async publish(slug: string, content: string): Promise<string> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      throw new Error(
        "MDX slug must contain lowercase letters, numbers, and hyphens",
      );
    await mkdir(this.contentDirectory, { recursive: true });
    const filePath = join(this.contentDirectory, `${slug}.mdx`);
    await writeFile(filePath, content, "utf8");
    return filePath;
  }

  async buildPublic(): Promise<string[]> {
    await mkdir(this.publicDirectory, { recursive: true });
    for (const name of await readdir(this.publicDirectory)) {
      if (name.endsWith(".mdx")) await unlink(join(this.publicDirectory, name));
    }
    const published: string[] = [];
    for (const name of await readdir(this.contentDirectory)) {
      if (!name.endsWith(".mdx")) continue;
      const source = join(this.contentDirectory, name);
      const content = await readFile(source, "utf8");
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
        content,
      );
      if (!frontmatter) continue;
      const document = parseDocument(frontmatter[1]!, { uniqueKeys: true });
      if (document.errors.length || document.get("visibility") !== "public")
        continue;
      const target = join(this.publicDirectory, basename(name));
      await writeFile(target, content, "utf8");
      published.push(target);
    }
    return published;
  }
}
