export function parseQuarantineApplyArgs(argv, env) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 3 ||
    argv[0] !== "--manifest" ||
    typeof argv[1] !== "string" ||
    argv[1].trim() === "" ||
    argv[2] !== "--apply"
  )
    throw new Error("Usage: --manifest <file> --apply");
  if (env?.FIXTURE_QUARANTINE_TEST_ONLY !== "true")
    throw new Error("FIXTURE_QUARANTINE_TEST_ONLY=true is required");
  if (typeof env?.DATABASE_URL !== "string" || env.DATABASE_URL.trim() === "")
    throw new Error("DATABASE_URL is required");
  return { manifestPath: argv[1], databaseUrl: env.DATABASE_URL };
}
