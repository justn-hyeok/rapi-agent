export interface ReleaseUnitOptions {
  currentPath: string;
  environmentPath: string;
  nodeBinary: string;
}
export function releaseUnitContents(
  options: ReleaseUnitOptions,
): Record<string, string>;
export function installReleaseUnits(
  options: ReleaseUnitOptions & {
    unitRoot: string;
    receiptPath: string;
    reload: () => Promise<unknown>;
    attemptId?: string;
  },
): Promise<void>;
