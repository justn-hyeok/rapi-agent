const PROJECT_PATTERN = /^rapi-restore-[a-z0-9-]+$/;
const DATABASE_PATTERN = /^rapi_restore_smoke_[a-z0-9_]+$/;
const MINIMUM_COUNTS = { tables: 21, migrations: 7, constraints: 20 };

export function restoreSmokeArtifact(input) {
  const { project, database, tables, migrations, constraints } = input ?? {};

  if (typeof project !== "string" || !PROJECT_PATTERN.test(project))
    throw new Error("project must match /^rapi-restore-[a-z0-9-]+$/");
  if (typeof database !== "string" || !DATABASE_PATTERN.test(database))
    throw new Error("database must match /^rapi_restore_smoke_[a-z0-9_]+$/");

  const counts = { tables, migrations, constraints };
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < MINIMUM_COUNTS[name])
      throw new Error(`${name} must be an integer >= ${MINIMUM_COUNTS[name]}`);
  }

  return { project, database, tables, migrations, constraints };
}
