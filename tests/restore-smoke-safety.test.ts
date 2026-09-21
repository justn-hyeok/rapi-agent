import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(
  new URL("../scripts/restore-smoke.sh", import.meta.url),
);

describe("restore smoke target safety", () => {
  it("requires disposable project and database before Docker can run", async () => {
    await assert.rejects(
      execFileAsync("bash", [script], {
        env: {
          PATH: "/usr/bin:/bin",
          RESTORE_SMOKE_PROJECT: "rapi",
          RESTORE_SMOKE_DATABASE: "rapi",
        },
      }),
      /RESTORE_SMOKE_PROJECT/,
    );
  });

  it("rejects an artifact path outside the owned evidence directory before Docker", async () => {
    await assert.rejects(
      execFileAsync("bash", [script], {
        env: {
          PATH: "/usr/bin:/bin",
          RESTORE_SMOKE_PROJECT: "rapi-restore-safe",
          RESTORE_SMOKE_DATABASE: "rapi_restore_smoke_safe",
          RESTORE_SMOKE_ARTIFACT: "/tmp/unsafe.json",
        },
      }),
      /RESTORE_SMOKE_ARTIFACT/,
    );
  });

  it("uses only an explicit disposable Compose project and database variable", async () => {
    const source = await readFile(script, "utf8");
    assert.match(source, /RESTORE_SMOKE_PROJECT must be a disposable/);
    assert.match(source, /RESTORE_SMOKE_DATABASE must be a disposable/);
    assert.match(
      source,
      /docker compose -p "\$restore_project" -f compose\.test\.yaml/,
    );
    assert.match(source, /"\$\{compose\[@\]\}" up -d --wait postgres/);
    assert.doesNotMatch(source, /-d rapi_restore_smoke(?:\s|$)/);
  });

  it("verifies the restored migration set exactly", async () => {
    const source = await readFile(script, "utf8");
    assert.match(source, /json_agg\(name ORDER BY name\)/);
    assert.match(source, /scripts\/verify-migration-set\.mjs/);
    assert.match(source, /--directory packages\/db\/migrations/);
    assert.match(source, /--applied "\$applied_migrations"/);
  });
});
