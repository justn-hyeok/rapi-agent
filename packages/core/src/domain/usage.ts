export interface UsageWindow {
  startsAt: Date;
  endsAt: Date;
}

function zonedParts(date: Date, timezone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function zonedDateToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const intended = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = new Date(intended);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate, timezone);
    const represented = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
    candidate = new Date(candidate.getTime() + intended - represented);
  }
  return candidate;
}

export function usageWindow(
  now: Date,
  timezone = "Asia/Seoul",
  resetHour = 5,
  resetMinute = 30,
): UsageWindow {
  const local = zonedParts(now, timezone);
  const todayReset = zonedDateToUtc(
    local.year!,
    local.month!,
    local.day!,
    resetHour,
    resetMinute,
    timezone,
  );
  const base = new Date(
    Date.UTC(
      local.year!,
      local.month! - 1,
      local.day! - (now < todayReset ? 1 : 0),
    ),
  );
  const startsAt = zonedDateToUtc(
    base.getUTCFullYear(),
    base.getUTCMonth() + 1,
    base.getUTCDate(),
    resetHour,
    resetMinute,
    timezone,
  );
  const next = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1),
  );
  const endsAt = zonedDateToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    resetHour,
    resetMinute,
    timezone,
  );
  return { startsAt, endsAt };
}
