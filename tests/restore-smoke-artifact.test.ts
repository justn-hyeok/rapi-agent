import assert from "node:assert/strict";
import test from "node:test";
import { restoreSmokeArtifact } from "../scripts/restore-smoke-artifact.mjs";

test("restore smoke artifact requires an isolated target and complete counts", () => {
  assert.deepEqual(
    restoreSmokeArtifact({
      project: "rapi-restore-1",
      database: "rapi_restore_smoke_1",
      tables: 21,
      migrations: 7,
      constraints: 20,
    }),
    {
      project: "rapi-restore-1",
      database: "rapi_restore_smoke_1",
      tables: 21,
      migrations: 7,
      constraints: 20,
    },
  );
  assert.throws(() =>
    restoreSmokeArtifact({
      project: "rapi-restore-1",
      database: "rapi_restore_smoke_1",
      tables: 20,
      migrations: 7,
      constraints: 20,
    }),
  );
  assert.throws(() =>
    restoreSmokeArtifact({
      project: "rapi",
      database: "rapi_restore_smoke_1",
      tables: 21,
      migrations: 7,
      constraints: 20,
    }),
  );
});
