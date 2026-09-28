export function expiredBackups(
  names: string[],
  now: Date,
  days?: number,
): string[];
export function prune(
  directory: string,
  now?: Date,
  days?: number,
): Promise<string[]>;
