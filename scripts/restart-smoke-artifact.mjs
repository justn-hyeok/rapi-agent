export function restartSmokeArtifact(input) {
  if (!input || typeof input !== "object")
    throw new Error("Restart smoke artifact input is required");
  const { project, database, before, after } = input;
  for (const [name, value] of Object.entries({
    project,
    database,
    before,
    after,
  })) {
    if (typeof value !== "string" || value.length === 0)
      throw new Error(
        `Restart smoke artifact ${name} must be a non-empty string`,
      );
  }
  if (before !== after)
    throw new Error("Restart smoke artifact counts changed across restart");
  if (before.split(":").every((count) => count === "0"))
    throw new Error("Restart smoke artifact cannot record an empty fixture");
  return { project, database, before, after };
}
