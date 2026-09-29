import { basename, dirname } from "node:path";

export function managedPreviousVersion(existing, expected, root) {
  const args = existing.ProgramArguments;
  if (
    !Array.isArray(args) ||
    args.length !== 3 ||
    args[0] !== expected.ProgramArguments[0] ||
    args[2] !== expected.ProgramArguments[2] ||
    typeof args[1] !== "string" ||
    dirname(dirname(args[1])) !== root ||
    basename(args[1]) !== "aside-bridge.mjs" ||
    !/^[a-f0-9]{64}$/.test(basename(dirname(args[1])))
  )
    throw new Error("Existing launch agent is not a managed Aside bridge");
  const keys = new Set([...Object.keys(existing), ...Object.keys(expected)]);
  for (const key of keys) {
    if (
      key !== "ProgramArguments" &&
      JSON.stringify(existing[key]) !== JSON.stringify(expected[key])
    )
      throw new Error("Existing launch agent policy differs");
  }
  return dirname(args[1]);
}
