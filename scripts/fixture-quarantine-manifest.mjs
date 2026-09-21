import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classifyFixtureRecord } from "./fixture-inventory.mjs";

function isPresent(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

export function buildQuarantineManifest(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("records must be an array");
  }
  const deactivateSubscriptionIds = new Set();
  const retainedFixtureIds = new Set();
  records.forEach((record, index) => {
    let classification;
    try {
      classification = classifyFixtureRecord(record);
    } catch {
      throw new Error(`record at index ${index} is not a plain object`);
    }
    if (classification === "ambiguous") {
      throw new Error(
        `record at index ${index} is ambiguous; no manifest produced`,
      );
    }
    if (classification !== "fixture") return;
    if (!isPresent(record.id)) {
      throw new Error(`fixture record at index ${index} is missing an id`);
    }
    const id = String(record.id);
    retainedFixtureIds.add(id);
    if (record.kind === "subscription") deactivateSubscriptionIds.add(id);
  });
  return {
    deactivateSubscriptionIds: [...deactivateSubscriptionIds].sort(),
    retainedFixtureIds: [...retainedFixtureIds].sort(),
  };
}

function usage() {
  return "Usage: node scripts/fixture-quarantine-manifest.mjs --input <file>";
}

export async function runQuarantineManifest(argv, { stdout, stderr } = {}) {
  const out = stdout ?? ((s) => process.stdout.write(s));
  const err = stderr ?? ((s) => process.stderr.write(s));
  if (argv.length !== 2 || argv[0] !== "--input" || !isPresent(argv[1])) {
    err(`${usage()}\n`);
    return 2;
  }
  let data;
  try {
    data = JSON.parse(await readFile(argv[1], "utf8"));
  } catch (error) {
    err(
      `fixture-quarantine-manifest: cannot read/parse ${argv[1]}: ${error.message}\n`,
    );
    return 1;
  }
  if (!Array.isArray(data)) {
    err("fixture-quarantine-manifest: input must be a JSON array of records\n");
    return 1;
  }
  const manifest = buildQuarantineManifest(data);
  out(`${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await runQuarantineManifest(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`fixture-quarantine-manifest: ${error.message}\n`);
    process.exitCode = 1;
  }
}
