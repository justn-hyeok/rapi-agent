const COLLECTABLE_KINDS = new Set(["github", "rss"]);

export interface SourceHealthInput {
  kind: string;
  active: boolean;
  failureCount: number;
  asideBridge?: boolean;
  lastSuccessAt?: string | Date | null;
}

export interface SourceHealthAssessment {
  configured: number;
  failing: number;
  unsupported: number;
  status: "ok" | "failed";
  reason?: string;
}

export function assessSourceHealth(
  sources: readonly SourceHealthInput[],
): SourceHealthAssessment {
  const active = sources.filter((source) => source.active);
  const supported = active.filter(
    (source) =>
      COLLECTABLE_KINDS.has(source.kind) ||
      (source.kind === "aside" && source.asideBridge === true),
  );
  const failing = supported.filter(
    (source) =>
      source.failureCount > 0 ||
      (source.kind === "aside" &&
        (!source.lastSuccessAt ||
          !Number.isFinite(new Date(source.lastSuccessAt).getTime()) ||
          Date.now() - new Date(source.lastSuccessAt).getTime() > 30 * 60_000)),
  ).length;
  const unsupported = active.length - supported.length;
  if (failing > 0)
    return {
      configured: supported.length,
      failing,
      unsupported,
      status: "failed",
      reason: `${failing} supported source(s) failing`,
    };
  if (unsupported > 0)
    return {
      configured: supported.length,
      failing,
      unsupported,
      status: "failed",
      reason: `${unsupported} active source(s) are not collectable by this worker`,
    };
  return {
    configured: supported.length,
    failing,
    unsupported,
    status: "ok",
  };
}
