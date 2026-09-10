export type HealthStatus = "ok" | "failed" | "unknown";

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  checkedAt: string;
  required: boolean;
  latencyMs?: number;
  lastSuccessAt?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ReadinessSummary {
  ready: boolean;
  checkedAt: string;
  components: ComponentHealth[];
}

export interface BackupStatusRecord {
  state?: "success" | "failed";
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export function assessBackupStatus(
  status: BackupStatusRecord,
  now = new Date(),
  maximumAgeMs = 26 * 60 * 60_000,
): { healthy: boolean; lastSuccessAt?: string; reason?: string } {
  const lastSuccessAt = status.lastSuccessAt;
  const lastSuccess = lastSuccessAt ? new Date(lastSuccessAt) : undefined;
  if (!lastSuccessAt || !lastSuccess || !Number.isFinite(lastSuccess.getTime()))
    return { healthy: false, reason: "backup success marker is missing" };
  if (status.state === "failed")
    return {
      healthy: false,
      lastSuccessAt,
      reason: "latest backup attempt failed",
    };
  if (now.getTime() - lastSuccess.getTime() > maximumAgeMs)
    return {
      healthy: false,
      lastSuccessAt,
      reason: "last successful backup is older than 26 hours",
    };
  return { healthy: true, lastSuccessAt };
}

export function summarizeReadiness(
  components: ComponentHealth[],
  now = new Date(),
  staleAfterMs = 60_000,
): ReadinessSummary {
  const checkedAt = now.toISOString();
  const normalized = components.map((component) => {
    const age = now.getTime() - new Date(component.checkedAt).getTime();
    return age > staleAfterMs
      ? {
          ...component,
          status: "unknown" as const,
          reason: "상태 확인이 오래되었습니다.",
        }
      : component;
  });
  return {
    ready: normalized.every(
      (component) => !component.required || component.status === "ok",
    ),
    checkedAt,
    components: normalized,
  };
}

export type HealthTransition = "down" | "recovered";

interface TransitionState {
  state: "initial" | "up" | "down";
  failures: number;
  successes: number;
}

export class HealthTransitionTracker {
  private readonly components = new Map<string, TransitionState>();

  constructor(
    private readonly failureThreshold = 3,
    private readonly recoveryThreshold = 2,
  ) {}

  observe(name: string, healthy: boolean): HealthTransition | undefined {
    const current = this.components.get(name) ?? {
      state: "initial" as const,
      failures: 0,
      successes: 0,
    };
    if (healthy) {
      current.failures = 0;
      current.successes += 1;
      if (current.state === "initial") {
        current.state = "up";
        current.successes = 0;
      } else if (
        current.state === "down" &&
        current.successes >= this.recoveryThreshold
      ) {
        current.state = "up";
        current.successes = 0;
        this.components.set(name, current);
        return "recovered";
      }
    } else {
      current.successes = 0;
      current.failures += 1;
      if (
        current.state !== "down" &&
        current.failures >= this.failureThreshold
      ) {
        current.state = "down";
        current.failures = 0;
        this.components.set(name, current);
        return "down";
      }
    }
    this.components.set(name, current);
    return undefined;
  }

  snapshot(): Record<string, TransitionState> {
    return Object.fromEntries(this.components);
  }

  restore(value: Record<string, TransitionState>): void {
    this.components.clear();
    for (const [name, state] of Object.entries(value))
      this.components.set(name, { ...state });
  }
}
