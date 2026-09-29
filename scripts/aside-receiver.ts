import { z } from "zod";
import { AsideCollector, RapiAgent } from "@rapi/agent";
import { PostgresStore } from "@rapi/db";

// SSH-only entrypoint; neither the DB URL nor a new public API is needed on the Mac.
let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  text += String(chunk);
  if (Buffer.byteLength(text) > 128 * 1024)
    throw new Error("Aside request too large");
}
const request = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("claim") }).strict(),
    z.object({ action: z.literal("complete"), snapshot: z.unknown() }).strict(),
    z
      .object({
        action: z.literal("fail"),
        sourceId: z.string().uuid(),
        token: z.string().uuid(),
      })
      .strict(),
  ])
  .parse(JSON.parse(text));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const store = new PostgresStore(process.env.DATABASE_URL);
const unavailable = () =>
  Promise.reject(new Error("Aside collection cannot send or execute tasks"));
const collector = new AsideCollector(
  new RapiAgent(store, { send: unavailable }, { dispatch: unavailable }),
);
try {
  let result: unknown;
  if (request.action === "claim") result = await collector.claim();
  else if (request.action === "complete")
    result = await collector.complete(request.snapshot);
  else {
    await collector.fail(request.sourceId, request.token);
    result = { failed: true };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  // No raw payload, cookie, account or page text in logs, including validation errors.
  process.stderr.write("Aside receiver rejected the request\n");
  process.exitCode = 1;
} finally {
  await store.close();
}
