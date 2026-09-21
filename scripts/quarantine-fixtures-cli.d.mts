export interface QuarantineApplyArgs {
  manifestPath: string;
  databaseUrl: string;
}

export function parseQuarantineApplyArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): QuarantineApplyArgs;
