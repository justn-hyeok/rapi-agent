import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FIXTURE_LOCATORS = new Set([
  "example/rapi",
  "https://example.com/feed.xml",
  "https://invalid.example/feed.xml",
  "approved-browser-session",
]);
const FIXTURE_OWNER_ID = "owner-1";
const FIXTURE_RECIPIENT_ID = "test@example.com";
const IDENTITY_FIELDS = ["ownerId", "recipientId"];

function isPresent(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function fixtureSentinels(field) {
  if (field === "ownerId") return new Set([FIXTURE_OWNER_ID]);
  if (field === "recipientId") return new Set([FIXTURE_RECIPIENT_ID]);
  return new Set();
}

export function classifyFixtureRecord(record) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new TypeError("record must be a plain object");
  }
  const hasFixtureEvidence =
    FIXTURE_LOCATORS.has(record.locator) ||
    record.ownerId === FIXTURE_OWNER_ID ||
    record.recipientId === FIXTURE_RECIPIENT_ID;
  const hasUnrelatedIdentity = IDENTITY_FIELDS.some(
    (field) =>
      isPresent(record[field]) && !fixtureSentinels(field).has(record[field]),
  );
  if (hasFixtureEvidence && hasUnrelatedIdentity) return "ambiguous";
  if (hasFixtureEvidence) return "fixture";
  return "live";
}

function usage() {
  return "Usage: node scripts/fixture-inventory.mjs --input <file>";
}

export async function runFixtureInventory(argv, { stdout, stderr } = {}) {
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
    err(`fixture-inventory: cannot read/parse ${argv[1]}: ${error.message}\n`);
    return 1;
  }
  if (!Array.isArray(data)) {
    err("fixture-inventory: input must be a JSON array of records\n");
    return 1;
  }
  const records = data.map((record, index) => {
    try {
      return { index, classification: classifyFixtureRecord(record) };
    } catch {
      throw new Error(`record at index ${index} is not a plain object`);
    }
  });
  const summary = { fixture: 0, live: 0, ambiguous: 0, total: records.length };
  for (const { classification } of records) summary[classification] += 1;
  out(`${JSON.stringify({ summary, records }, null, 2)}\n`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await runFixtureInventory(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`fixture-inventory: ${error.message}\n`);
    process.exitCode = 1;
  }
}
