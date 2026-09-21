import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
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
      const message = await this.request(`/channels/${channelId}/messages`, {
        content,
      });
      providerId = String(message.id);
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
    return (await response.json()) as Record<string, unknown>;
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  servername?: string;
}

function safeHeader(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Email header contains a newline");
  return value;
}

function createResponseReader(socket: TLSSocket): () => Promise<string> {
  let buffer = "";
  const waiting: Array<(value: string) => void> = [];
  const responses: string[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\r\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!/^\d{3} /.test(line)) continue;
      const waiter = waiting.shift();
      if (waiter) waiter(line);
      else responses.push(line);
    }
  });
  return () => {
    const ready = responses.shift();
    return ready
      ? Promise.resolve(ready)
      : new Promise((resolve) => waiting.push(resolve));
  };
}

export class SmtpDeliveryAdapter implements DeliveryAdapter {
  constructor(private readonly options: SmtpOptions) {}

  async send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
    idempotencyKey: string,
  ): Promise<DeliveryResult> {
    if (target.channel !== "email")
      throw new Error("SMTP adapter received a non-email target");
    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const connection = tlsConnect(
        {
          host: this.options.host,
          port: this.options.port,
          servername: this.options.servername ?? this.options.host,
        },
        () => resolve(connection),
      );
      connection.once("error", reject);
    });
    const readResponse = createResponseReader(socket);
    const command = async (value: string, expected: number): Promise<void> => {
      socket.write(`${value}\r\n`);
      const response = await readResponse();
      if (!response.startsWith(String(expected)))
        throw new Error(`SMTP command failed: ${response}`);
    };
    try {
      const greeting = await readResponse();
      if (!greeting.startsWith("220"))
        throw new Error(`SMTP greeting failed: ${greeting}`);
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
      const messageId = `<${idempotencyKey}@rapi-agent.local>`;
      const message = [
        `From: ${safeHeader(this.options.from)}`,
        `To: ${safeHeader(target.recipientId)}`,
        `Subject: ${safeHeader(payload.subject)}`,
        `Message-ID: ${messageId}`,
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
      await command(`${message}\r\n.`, 250);
      await command("QUIT", 221);
      return { providerId: messageId };
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
      if (!/^visibility: public$/m.test(content)) continue;
      const target = join(this.publicDirectory, basename(name));
      await writeFile(target, content, "utf8");
      published.push(target);
    }
    return published;
  }
}
