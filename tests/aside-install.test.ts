import assert from "node:assert/strict";
import { test } from "node:test";
import { managedPreviousVersion } from "../scripts/aside-install-guard.mjs";

test("allows an intact managed runtime upgrade and rejects conflicting launch jobs", () => {
  const root = "/app/aside-bridge";
  const previous = `${root}/${"a".repeat(64)}`;
  const existing = {
    Label: "me.justn.rapi-aside-bridge",
    StartInterval: 60,
    ProgramArguments: [
      "/usr/bin/node",
      `${previous}/aside-bridge.mjs`,
      `${root}/config.json`,
    ],
  };
  const expected = {
    ...existing,
    ProgramArguments: [
      "/usr/bin/node",
      `${root}/${"b".repeat(64)}/aside-bridge.mjs`,
      `${root}/config.json`,
    ],
  };
  assert.equal(managedPreviousVersion(existing, expected, root), previous);
  assert.throws(() =>
    managedPreviousVersion({ ...existing, Label: "other-job" }, expected, root),
  );
  assert.throws(() =>
    managedPreviousVersion({ ...existing, StartInterval: 1 }, expected, root),
  );
  assert.throws(() =>
    managedPreviousVersion(
      { ...existing, unexpectedPolicy: true },
      expected,
      root,
    ),
  );
  assert.throws(() =>
    managedPreviousVersion(
      {
        ...existing,
        ProgramArguments: [
          "/usr/bin/node",
          "/unrelated/job.mjs",
          `${root}/config.json`,
        ],
      },
      expected,
      root,
    ),
  );
});
