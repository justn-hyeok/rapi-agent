export function atomicJson(file: string, data: unknown): Promise<void>;
export function readJson<T>(file: string, fallback: T): Promise<T>;
export function removePublication(
  action: { path: string; hash: string },
  roots: string[],
): Promise<string>;
export function backupInventory(
  directory: string,
  catalogFile?: string,
  now?: Date,
): Promise<Array<{ path: string; expiresAt: string }>>;
export function registerBackup(
  catalogFile: string,
  file: string,
  roots: string[],
  now?: Date,
): Promise<void>;
export function backupsGone(
  entries: Array<{ path: string; expiresAt: string }>,
): Promise<boolean>;
export function updateLedger(file: string, request: unknown): Promise<void>;
