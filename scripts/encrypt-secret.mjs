import { createCipheriv, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

const encodedKey = process.env.WEBHOOK_ENCRYPTION_KEY;
if (!encodedKey) throw new Error("WEBHOOK_ENCRYPTION_KEY is required");
const key = Buffer.from(encodedKey, "base64");
if (key.length !== 32)
  throw new Error("WEBHOOK_ENCRYPTION_KEY must be 32 bytes encoded as base64");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const secret = Buffer.concat(chunks)
  .toString("utf8")
  .replace(/\r?\n$/, "");
if (!secret) throw new Error("Provide the secret on stdin");
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ciphertext = Buffer.concat([
  cipher.update(secret, "utf8"),
  cipher.final(),
]);
process.stdout.write(
  [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".") + "\n",
);
