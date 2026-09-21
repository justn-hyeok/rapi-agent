import assert from "node:assert/strict";
import test from "node:test";
import {
  assertQuarantineDatabaseUrl,
  parseQuarantineManifest,
} from "../scripts/quarantine-fixtures.mjs";

test("quarantine manifest fails closed and only admits rapi_test", () => {
  assert.deepEqual(
    parseQuarantineManifest({
      deactivateSubscriptionIds: ["sub-1"],
      retainedFixtureIds: ["source-1", "sub-1"],
    }),
    {
      deactivateSubscriptionIds: ["sub-1"],
      retainedFixtureIds: ["source-1", "sub-1"],
    },
  );
  assert.throws(() =>
    parseQuarantineManifest({
      deactivateSubscriptionIds: ["sub-1"],
      retainedFixtureIds: [],
    }),
  );
  assert.throws(() =>
    parseQuarantineManifest({
      deactivateSubscriptionIds: ["sub-1", "sub-1"],
      retainedFixtureIds: ["sub-1"],
    }),
  );
  assert.equal(
    assertQuarantineDatabaseUrl("postgresql://rapi@127.0.0.1/rapi_test")
      .pathname,
    "/rapi_test",
  );
  assert.throws(() =>
    assertQuarantineDatabaseUrl("postgresql://rapi@db.example/rapi_test"),
  );
});
