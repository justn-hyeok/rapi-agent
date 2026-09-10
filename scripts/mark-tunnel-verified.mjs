import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const origin = process.argv[2]?.replace(/\/$/, "");
const target = resolve(
  process.env.PUBLIC_TUNNEL_VERIFIED_FILE ??
    "/var/lib/rapi/tunnel-verified.json",
);
if (!origin?.startsWith("https://"))
  throw new Error("HTTPS origin이 필요합니다.");
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
const temporary = `${target}.${process.pid}.tmp`;
await writeFile(
  temporary,
  `${JSON.stringify({ origin, verifiedAt: new Date().toISOString() })}\n`,
  { mode: 0o600 },
);
await rename(temporary, target);
