export type FixtureClassification = "fixture" | "live" | "ambiguous";

export interface FixtureRecord {
  locator?: unknown;
  ownerId?: unknown;
  recipientId?: unknown;
  [key: string]: unknown;
}

export function classifyFixtureRecord(
  record: FixtureRecord,
): FixtureClassification;
