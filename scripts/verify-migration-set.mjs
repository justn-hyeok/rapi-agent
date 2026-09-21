#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";

const USAGE =
  "usage: verify-migration-set --directory <migrations-dir> --applied <applied.json>";
const MIGRATION_NAME = /^\d+.*\.sql$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if ((key !== "--directory" && key !== "--applied") || value === undefined) {
      return null;
    }
    if (args[key.slice(2)] !== undefined) return null;
    args[key.slice(2)] = value;
  }
  return args.directory && args.applied ? args : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) fail(USAGE);

  let entries;
  try {
    entries = await readdir(args.directory);
  } catch (error) {
    fail(`error: cannot read directory ${args.directory}: ${error.message}`);
  }

  const expected = [
    ...new Set(entries.filter((name) => MIGRATION_NAME.test(name))),
  ].sort();

  let appliedRaw;
  try {
    appliedRaw = await readFile(args.applied, "utf8");
  } catch (error) {
    fail(`error: cannot read applied file ${args.applied}: ${error.message}`);
  }

  let appliedList;
  try {
    appliedList = JSON.parse(appliedRaw);
  } catch (error) {
    fail(`error: applied file is not valid JSON: ${error.message}`);
  }

  if (
    !Array.isArray(appliedList) ||
    appliedList.some((item) => typeof item !== "string")
  ) {
    fail("error: applied file must be a JSON array of strings");
  }

  const applied = [...new Set(appliedList)].sort();
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !appliedSet.has(name));
  const unexpected = applied.filter((name) => !expectedSet.has(name));
  const ok = missing.length === 0 && unexpected.length === 0;

  process.stdout.write(
    `${JSON.stringify({ expected, applied, missing, unexpected, ok })}\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((error) => fail(`error: ${error.message}`));
