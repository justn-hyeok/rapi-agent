import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// Install outside the release pointer. Resolve it exactly once so a pointer
// change during validation cannot switch the code that starts listening.
const release = await realpath(
  process.env.RAPI_CURRENT_RELEASE ?? "/home/justn/rapi-releases/current",
);
process.stdout.write(`${JSON.stringify({ gatewayRelease: release })}\n`);
await import(
  pathToFileURL(join(release, "scripts/check-withdrawal-support.mjs")).href
);
await import(pathToFileURL(join(release, "ops/gateway/run.mjs")).href);
