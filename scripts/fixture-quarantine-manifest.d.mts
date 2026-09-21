import type { FixtureRecord } from "./fixture-inventory.mjs";

export interface QuarantineRecord extends FixtureRecord {
  id?: unknown;
  kind?: unknown;
}

export interface QuarantineManifest {
  deactivateSubscriptionIds: string[];
  retainedFixtureIds: string[];
}

export function buildQuarantineManifest(
  records: QuarantineRecord[],
): QuarantineManifest;
