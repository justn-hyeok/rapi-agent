import type { Client } from "pg";
export interface PrivacyConfig {
  key: string;
  withdrawalsFile: string;
  publicationRoots: string[];
  backupDirectory: string;
  backupCatalogFile?: string;
  ledgerFile: string;
  now?: Date;
}
export interface Plan {
  items: string[];
  subscriptions: string[];
  batches: string[];
  tasks: string[];
  runs: string[];
  memories: string[];
  chats: string[];
  usages: string[];
  ambiguousIds: string[];
  ambiguous: number;
  files: Array<{ path: string; hash: string }>;
  cutoff: string;
}
export function privacyRef(key: string, label: string, value: string): string;
export function planDeletion(
  client: Client,
  kind: string,
  target: string,
  now?: Date,
): Promise<Plan>;
export function planCounts(plan: Plan): Record<string, number>;
export function requestDeletion(
  client: Client,
  input: {
    guildId: string;
    userId: string;
    kind: string;
    target?: string;
    admin?: boolean;
    key: string;
    now?: Date;
  },
): Promise<{
  id: string;
  state: string;
  counts: Record<string, number>;
  ambiguous: number;
}>;
export function deletionStatus(
  client: Client,
  input: { id: string; guildId: string; userId: string; key: string },
): Promise<{
  id: string;
  state: string;
  counts: Record<string, number>;
  backupDeadline?: Date;
  error?: string;
}>;
export function confirmDeletion(
  client: Client,
  input: {
    id: string;
    guildId: string;
    userId: string;
    key: string;
    admin?: boolean;
  },
): Promise<{ id: string; state: string }>;
export function processDeletion(
  client: Client,
  id: string,
  config: PrivacyConfig,
): Promise<{
  id: string;
  state: string;
  backupDeadline?: string;
  counts?: Record<string, number>;
}>;
export function finishDeletionBackups(
  client: Client,
  config: PrivacyConfig,
): Promise<number>;
export function finishDeletionFiles(
  client: Client,
  id: string,
  config: PrivacyConfig,
): Promise<void>;
export function sweepMetadata(
  client: Client,
  input: { key: string; withdrawalsFile?: string; now?: Date; apply?: boolean },
): Promise<{
  anonymizedReceipts: number;
  deliveryAudits: number;
  taskAudits: number;
  rawMetadata: number;
  chatopsAudits: number;
  applied: boolean;
}>;
