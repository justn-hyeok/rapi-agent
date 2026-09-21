import assert from "node:assert/strict";
import test from "node:test";
import { parseQuarantineApplyArgs } from "../scripts/quarantine-fixtures-cli.mjs";

test("quarantine apply requires explicit test-only intent", () => {
  const env = {
    FIXTURE_QUARANTINE_TEST_ONLY: "true",
    DATABASE_URL: "postgresql://rapi@127.0.0.1/rapi_test",
  };
  assert.deepEqual(
    parseQuarantineApplyArgs(
      ["--manifest", "/tmp/fixture.json", "--apply"],
      env,
    ),
    { manifestPath: "/tmp/fixture.json", databaseUrl: env.DATABASE_URL },
  );
  assert.throws(() =>
    parseQuarantineApplyArgs(["--manifest", "/tmp/fixture.json"], env),
  );
  assert.throws(() =>
    parseQuarantineApplyArgs(["--manifest", "/tmp/fixture.json", "--apply"], {
      DATABASE_URL: env.DATABASE_URL,
    }),
  );
});
