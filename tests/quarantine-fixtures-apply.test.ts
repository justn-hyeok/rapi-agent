import assert from "node:assert/strict";
import test from "node:test";
import { buildQuarantineUpdate } from "../scripts/quarantine-fixtures-apply.mjs";

test("quarantine update is parameterized and rejects malformed ids", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const update = buildQuarantineUpdate([id]);
  assert.match(update.text, /ANY\(\$1::uuid\[\]\)/);
  assert.match(update.text, /state='inactive'/);
  assert.deepEqual(update.values, [[id]]);
  assert.throws(() => buildQuarantineUpdate([]));
  assert.throws(() => buildQuarantineUpdate(["production-subscription"]));
  assert.throws(() => buildQuarantineUpdate([id, id]));
});
