import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { readWithdrawals, filterWithdrawnBlog } from "./blog-withdrawals.mjs";

// Persist this ExecStartPre in systemd across release changes. A rollback to a
// release without withdrawal support must fail closed, including interactions.
const gateway = await readFile(
  new URL("../ops/gateway/run.mjs", import.meta.url),
  "utf8",
);
if (
  !gateway.includes("filterWithdrawnBlog(name, body, slugs)") ||
  !gateway.includes("RAPI_BLOG_WITHDRAWALS_REQUIRED")
)
  throw new Error("Gateway release lacks publication withdrawal support");
await readWithdrawals(process.env.RAPI_BLOG_WITHDRAWALS_FILE, true);
if (
  filterWithdrawnBlog("guard.html", Buffer.from("withdrawn"), ["guard"]) !==
  null
)
  throw new Error("Withdrawal guard failed");
