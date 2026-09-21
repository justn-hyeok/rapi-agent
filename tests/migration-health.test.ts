import assert from "node:assert/strict";
import { test } from "node:test";
import { compareMigrationNames } from "../packages/db/src/index.js";

test("migration health accepts an exact set", () => {
  assert.deepEqual(
    compareMigrationNames(["0001.sql", "0002.sql"], ["0001.sql", "0002.sql"]),
    { missing: [], unexpected: [], ok: true },
  );
});

test("migration health reports missing and unexpected names", () => {
  assert.deepEqual(
    compareMigrationNames(
      ["0001.sql", "0002.sql", "0008.sql"],
      ["0001.sql", "extra.sql"],
    ),
    { missing: ["0002.sql", "0008.sql"], unexpected: ["extra.sql"], ok: false },
  );
});
