import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTestDatabaseUrl } from "../scripts/test-database-admission.mjs";

test("accepts only loopback rapi_test PostgreSQL URLs", () => {
  assert.equal(
    assertTestDatabaseUrl("postgresql://rapi:password@localhost:5432/rapi_test")
      .hostname,
    "localhost",
  );
  assert.equal(
    assertTestDatabaseUrl("postgresql://rapi:password@127.0.0.1:5432/rapi_test")
      .hostname,
    "127.0.0.1",
  );
});

for (const [label, value] of [
  ["production database", "postgresql://rapi:password@localhost:5432/rapi"],
  ["remote host", "postgresql://rapi:password@db.example.com:5432/rapi_test"],
  [
    "database query override",
    "postgresql://rapi:password@localhost:5432/rapi_test?database=rapi",
  ],
  ["malformed URL", "not a URL"],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => assertTestDatabaseUrl(value), /Test database URL/);
  });
}
