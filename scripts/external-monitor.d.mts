export interface Probe {
  name: string;
  ok: boolean;
  status?: number | string;
}
export function probeOrigin(
  origin: string,
  request?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<Probe[]>;
export function monitor(options: {
  origin: string;
  mode?: string;
  api: (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<unknown>;
  notify: (content: string) => Promise<{ id: string }>;
  probe: (origin: string) => Promise<Probe[]>;
}): Promise<{
  healthy: boolean;
  checks: Probe[];
  transition: string;
  issue?: number;
}>;
