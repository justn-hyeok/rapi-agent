// Korean schedule phrases ("금요일 오후 3시 면담", "10/20 해커톤 마감") parsed
// deterministically in Asia/Seoul. Ambiguous input fails instead of guessing.

const ZONE_OFFSET_MINUTES = 9 * 60; // Asia/Seoul has no daylight saving time.
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export interface ParsedSchedule {
  title: string;
  startsAt: Date;
  allDay: boolean;
}

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function localToday(now: Date): LocalDate {
  const local = new Date(now.getTime() + ZONE_OFFSET_MINUTES * 60_000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function weekday(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function valid(date: LocalDate): boolean {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return (
    value.getUTCFullYear() === date.year &&
    value.getUTCMonth() === date.month - 1 &&
    value.getUTCDate() === date.day
  );
}

/** A month/day without a year means its next occurrence (today counts). */
function nextOccurrence(
  today: LocalDate,
  month: number,
  day: number,
): LocalDate {
  const candidate = { year: today.year, month, day };
  const before =
    month < today.month || (month === today.month && day < today.day);
  return before ? { ...candidate, year: today.year + 1 } : candidate;
}

export function parseScheduleText(
  input: string,
  now = new Date(),
): ParsedSchedule | { error: string } {
  let text = ` ${input.trim().replace(/\s+/g, " ")} `;
  const today = localToday(now);
  let date: LocalDate | undefined;
  const take = (pattern: RegExp): RegExpExecArray | null => {
    const match = pattern.exec(text);
    if (match) text = text.replace(match[0], " ");
    return match;
  };

  let m: RegExpExecArray | null;
  if ((m = take(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/)))
    date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  else if ((m = take(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)))
    date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  else if ((m = take(/(\d{1,2})월\s*(\d{1,2})일/)))
    date = nextOccurrence(today, Number(m[1]), Number(m[2]));
  else if ((m = take(/(?<![\d:])(\d{1,2})\/(\d{1,2})(?![\d:])/)))
    date = nextOccurrence(today, Number(m[1]), Number(m[2]));
  else if ((m = take(/\s(오늘|내일|모레|글피)\s/)))
    date = addDays(today, ["오늘", "내일", "모레", "글피"].indexOf(m[1]!));
  else if (
    (m = take(/\s(다음\s?주|담주|이번\s?주)?\s?([일월화수목금토])요일\s/))
  ) {
    const target = WEEKDAYS.indexOf(m[2]!);
    const current = weekday(today);
    // Plain or "이번주" weekday: its next occurrence, today included.
    let offset = (target - current + 7) % 7;
    if (m[1] && /다음|담/.test(m[1])) {
      // "다음주": that weekday in the Monday-start week after this one.
      const sinceMonday = (current + 6) % 7;
      offset = 7 - sinceMonday + ((target + 6) % 7);
    }
    date = addDays(today, offset);
  } else if ((m = take(/(?<![\d:/월])(\d{1,2})일(?!\s*(?:뒤|후))/))) {
    // A bare day of month: this month if not past, otherwise next month.
    const day = Number(m[1]);
    const month = day >= today.day ? today : addDays({ ...today, day: 1 }, 32);
    date = { year: month.year, month: month.month, day };
  } else if ((m = take(/(\d{1,3})일\s*(?:뒤|후)/)))
    date = addDays(today, Number(m[1]));

  if (!date || !valid(date))
    return {
      error: "날짜를 찾지 못했습니다. 예: 10/20, 10월 20일, 내일, 금요일",
    };

  let hour: number | undefined;
  let minute = 0;
  if ((m = take(/(\d{1,2}):(\d{2})/))) {
    hour = Number(m[1]);
    minute = Number(m[2]);
  } else if (
    (m = take(/(오전|오후|아침|저녁|밤|낮)?\s?(\d{1,2})시\s?(반|(\d{1,2})분)?/))
  ) {
    hour = Number(m[2]);
    minute = m[3] === "반" ? 30 : m[4] ? Number(m[4]) : 0;
    const period = m[1];
    if (
      (period === "오후" || period === "저녁" || period === "밤") &&
      hour < 12
    )
      hour += 12;
    if (period === "낮" && hour < 7) hour += 12;
    if (period === "오전" && hour === 12) hour = 0;
  }
  if (hour !== undefined && (hour > 23 || minute > 59))
    return { error: "시간을 이해하지 못했습니다. 예: 오후 3시, 15:30" };

  const title = text
    .replace(/\s(에|까지|부터)\s/g, " ")
    .replace(/^\s*(에|까지)\s/, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(에|까지)\s+/, "");
  if (!title)
    return { error: "일정 내용을 함께 적어 주세요. 예: 금요일 3시 면담" };
  const startsAt = new Date(
    Date.UTC(date.year, date.month - 1, date.day, hour ?? 0, minute) -
      ZONE_OFFSET_MINUTES * 60_000,
  );
  return { title: title.slice(0, 200), startsAt, allDay: hour === undefined };
}

/** "10/11 (토) 14:00" in Asia/Seoul. */
export function formatScheduleWhen(startsAt: Date, allDay: boolean): string {
  const local = new Date(startsAt.getTime() + ZONE_OFFSET_MINUTES * 60_000);
  const base = `${local.getUTCMonth() + 1}/${local.getUTCDate()} (${WEEKDAYS[local.getUTCDay()]})`;
  if (allDay) return base;
  return `${base} ${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

/** Whole days from today (Asia/Seoul) to the event's local date. */
export function scheduleDaysUntil(startsAt: Date, now = new Date()): number {
  const day = (value: Date) => {
    const local = localToday(value);
    return Date.UTC(local.year, local.month - 1, local.day);
  };
  return Math.round((day(startsAt) - day(now)) / 86_400_000);
}
