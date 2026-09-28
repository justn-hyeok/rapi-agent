export interface ServiceDriver {
  active(services: string[]): Promise<string[]>;
  stop(services: string[]): Promise<void>;
  start(services: string[]): Promise<void>;
  ready(services: string[], sha: string): Promise<void>;
}
export function configuredHealthPorts(
  environment: Record<string, string | undefined>,
): Record<string, number>;
export function systemdDriver(
  endpointPorts?: Record<string, number>,
  maximumAttempts?: number,
): ServiceDriver;
export function switchRelease(options: {
  currentPath: string;
  candidatePath: string;
  expectedSha: string;
  services: string[];
  receiptPath: string;
  driver: ServiceDriver;
  schemaMigration?: {
    namesAdded: string[];
    upgrade(): Promise<void>;
    rollback(): Promise<void>;
  };
}): Promise<{ status: string; rollback: string | null }>;
