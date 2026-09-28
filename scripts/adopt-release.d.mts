import type { ServiceDriver } from "./switch-release.mjs";
export interface LegacyDriver extends ServiceDriver {
  snapshot(): Promise<{
    active: string[];
    appliedMigrations: string[];
    [key: string]: unknown;
  }>;
  legacyReady(services: string[]): Promise<void>;
  wire(attemptId: string): Promise<void>;
  restore(attemptId: string): Promise<void>;
}
export function adoptRelease(options: {
  currentPath: string;
  candidatePath: string;
  expectedSha: string;
  receiptPath: string;
  wiringReceiptPath: string;
  driver: LegacyDriver;
}): Promise<{ status: string; rollback: string | null }>;
