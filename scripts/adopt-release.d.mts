import type { ServiceDriver } from "./switch-release.mjs";
export interface LegacyDriver extends ServiceDriver {
  snapshot(): Promise<{ active: string[]; [key: string]: unknown }>;
  legacyReady(services: string[]): Promise<void>;
  wire(): Promise<void>;
  restore(): Promise<void>;
}
export function adoptRelease(options: {
  currentPath: string;
  candidatePath: string;
  expectedSha: string;
  receiptPath: string;
  driver: LegacyDriver;
}): Promise<{ status: string; rollback: string | null }>;
