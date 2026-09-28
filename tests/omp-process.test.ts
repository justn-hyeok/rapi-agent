import assert from "node:assert/strict";
import { test } from "node:test";
import { runChild } from "../apps/omp/src/process.js";

test("OMP timeout and cancellation kill children that ignore SIGTERM", async () => {
  const code = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);';
  const env = { PATH: process.env.PATH };
  await assert.rejects(
    runChild(process.execPath, ["-e", code], { env, timeoutMs: 150 }),
    /timed out/,
  );
  const controller = new AbortController();
  const work = runChild(process.execPath, ["-e", code], {
    env,
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  setTimeout(() => controller.abort(), 150);
  const result = await work;
  assert.notEqual(result.code, 0);
});

test("OMP output is bounded and a pre-cancelled request never launches", async () => {
  await assert.rejects(
    runChild(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(2_000_000));'],
      {
        env: {},
        timeoutMs: 5_000,
      },
    ),
    /exceeds/,
  );
  await assert.rejects(
    runChild("a-command-that-must-not-start", [], {
      env: {},
      signal: AbortSignal.abort(),
    }),
    /cancelled/,
  );
});
