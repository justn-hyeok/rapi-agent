export interface ReleaseManifest {
  sha: string;
  tree: string;
  stagedPath: string;
  verifiedAt: string;
  gates: string[];
  switched: false;
  files: Record<string, string>;
  migrations: string[];
}
export function releaseFileDigests(
  root: string,
): Promise<Record<string, string>>;
export function verifyRelease(
  root: string,
  expectedSha?: string,
): Promise<ReleaseManifest>;
