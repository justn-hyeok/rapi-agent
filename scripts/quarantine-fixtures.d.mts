export interface QuarantineManifest {
  deactivateSubscriptionIds: string[];
  retainedFixtureIds: string[];
}

export function parseQuarantineManifest(value: unknown): QuarantineManifest;
export function assertQuarantineDatabaseUrl(value: string): URL;
