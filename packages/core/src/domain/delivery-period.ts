export type DeliveryPeriodCadence = "daily" | "weekly";

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localCalendarParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing ${type} in formatted date`);
    return part.value;
  };
  const weekday = WEEKDAY_INDEX[value("weekday")];
  if (weekday === undefined) throw new Error("Unrecognized weekday");
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    weekday,
  };
}

function formatLocalDateTime(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Missing ${type} in formatted date`);
    return Number(part.value);
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedMidnight(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = formatLocalDateTime(new Date(candidate), timeZone);
    const observed = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const next = target - (observed - candidate);
    if (next === candidate) return new Date(next);
    candidate = next;
  }
  throw new Error(`Could not resolve local midnight in ${timeZone}`);
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function keyForDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function deliveryPeriodKey(
  now: Date,
  cadence: DeliveryPeriodCadence,
  timeZone: string,
): string {
  const { year, month, day, weekday } = localCalendarParts(now, timeZone);
  const start = addCalendarDays(
    year,
    month,
    day,
    cadence === "weekly" ? -((weekday + 6) % 7) : 0,
  );
  return keyForDate(start.year, start.month, start.day);
}

export function deliveryPeriodWindow(
  now: Date,
  cadence: DeliveryPeriodCadence,
  timeZone: string,
): { key: string; start: Date; end: Date } {
  const { year, month, day, weekday } = localCalendarParts(now, timeZone);
  const startDate = addCalendarDays(
    year,
    month,
    day,
    cadence === "weekly" ? -((weekday + 6) % 7) : 0,
  );
  const endDate = addCalendarDays(
    startDate.year,
    startDate.month,
    startDate.day,
    cadence === "weekly" ? 7 : 1,
  );
  return {
    key: keyForDate(startDate.year, startDate.month, startDate.day),
    start: zonedMidnight(
      startDate.year,
      startDate.month,
      startDate.day,
      timeZone,
    ),
    end: zonedMidnight(endDate.year, endDate.month, endDate.day, timeZone),
  };
}
