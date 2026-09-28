export function readWithdrawals(
  file?: string,
  required?: boolean,
): Promise<string[]>;
export function recordWithdrawals(
  file: string,
  slugs: string[],
): Promise<string[]>;
export function filterWithdrawnBlog(
  name: string,
  body: Buffer,
  slugs: string[],
): Buffer | null;
