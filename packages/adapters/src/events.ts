import { readSource } from "./sources.js";

export interface CollectedEvent {
  externalKey: string;
  source: "dev-event" | "devpost" | "cfp";
  kind: "deadline" | "event";
  title: string;
  startsAt: Date;
  allDay: boolean;
  url: string | null;
  note: string | null;
}

const KST = 9 * 3_600_000;
const kstDate = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min) - KST);

// Contest-like categories only; webinars and lectures are too frequent to schedule.
const DEV_EVENT_TAGS = ["대회", "해커톤", "공모전", "컨퍼런스", "CFP"];

/** brave-people/Dev-Event README: one "## `26년 10월`" block per month. */
export function parseDevEvent(markdown: string, now: Date): CollectedEvent[] {
  const events: CollectedEvent[] = [];
  let year = 0;
  let month = 0;
  let current: {
    title: string;
    url: string;
    tags: string[];
    lines: string[];
  } | null = null;
  const flush = () => {
    if (!current || !year) return;
    const tag = DEV_EVENT_TAGS.find((name) => current!.tags.includes(name));
    if (!tag) return;
    const field = (name: string) =>
      current!.lines
        .find((line) => line.startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim();
    const period = field("접수") ?? field("일시");
    if (!period) return;
    const deadline = field("접수") !== undefined;
    const part = deadline ? period.split("~").pop()! : period.split("~")[0]!;
    const match =
      /(\d{1,2})\.\s*(\d{1,2})\s*(?:\([^)]*\))?\s*(?:(\d{1,2}):(\d{2}))?/.exec(
        part,
      );
    if (!match) return;
    const m = Number(match[1]);
    const d = Number(match[2]);
    const y =
      m < month && month - m > 6
        ? year + 1
        : m > month && m - month > 6
          ? year - 1
          : year;
    const hasTime = match[3] !== undefined;
    const startsAt = kstDate(
      y,
      m,
      d,
      hasTime ? Number(match[3]) : 0,
      hasTime ? Number(match[4]) : 0,
    );
    if (startsAt.getTime() < now.getTime() - 86_400_000) return;
    events.push({
      externalKey: `dev-event:${current.url}`,
      source: "dev-event",
      kind: deadline ? "deadline" : "event",
      title: `[${tag}] ${current.title}${deadline ? " 접수 마감" : ""}`,
      startsAt,
      allDay: !hasTime,
      url: current.url,
      note: current.tags.join(", "),
    });
  };
  for (const raw of markdown.split("\n")) {
    const header = /^##\s*`(\d{2})년\s*(\d{1,2})월`/.exec(raw);
    if (header) {
      flush();
      current = null;
      year = 2000 + Number(header[1]);
      month = Number(header[2]);
      continue;
    }
    const entry = /^-\s*__\[(.+?)\]\((https?:\/\/[^)\s]+)\)__/.exec(raw);
    if (entry) {
      flush();
      current = {
        title: entry[1]!.replace(/\\([[\]])/g, "$1"),
        url: entry[2]!,
        tags: [],
        lines: [],
      };
      continue;
    }
    const sub = /^\s+-\s*(.+)$/.exec(raw);
    if (sub && current) {
      const line = sub[1]!.trim();
      current.lines.push(line);
      if (line.startsWith("분류:"))
        current.tags = [...line.matchAll(/`([^`]+)`/g)].map((tag) => tag[1]!);
    }
  }
  flush();
  return events;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Devpost open/upcoming online AI hackathons; the deadline is the period end. */
export function parseDevpost(json: unknown, now: Date): CollectedEvent[] {
  const list = (json as { hackathons?: unknown[] } | null)?.hackathons ?? [];
  const events: CollectedEvent[] = [];
  for (const item of list) {
    const h = item as Record<string, unknown>;
    const title = typeof h.title === "string" ? h.title : "";
    const url = typeof h.url === "string" ? h.url : "";
    const dates =
      typeof h.submission_period_dates === "string"
        ? h.submission_period_dates
        : "";
    const location =
      (h.displayed_location as { location?: string } | undefined)?.location ??
      "";
    const themes = Array.isArray(h.themes)
      ? h.themes.map((theme) => text((theme as { name?: unknown }).name))
      : [];
    if (
      !title ||
      !url ||
      location !== "Online" ||
      !themes.some((t) => /AI|Machine Learning/i.test(t))
    )
      continue;
    const startMonth = /^([A-Z][a-z]{2})/.exec(dates)?.[1];
    const end = /(?:([A-Z][a-z]{2})\s+)?(\d{1,2}),\s*(\d{4})\s*$/.exec(dates);
    const monthName = end?.[1] ?? startMonth;
    if (!end || !monthName || !MONTHS.includes(monthName)) continue;
    const startsAt = kstDate(
      Number(end[3]),
      MONTHS.indexOf(monthName) + 1,
      Number(end[2]),
    );
    if (startsAt.getTime() < now.getTime() - 86_400_000) continue;
    events.push({
      externalKey: `devpost:${url}`,
      source: "devpost",
      kind: "deadline",
      title: `[해커톤] ${title} 제출 마감`,
      startsAt,
      allDay: true,
      url,
      note: themes.join(", "),
    });
  }
  return events;
}

const CFP_COUNTRIES = new Set([
  "South Korea",
  "Korea",
  "Japan",
  "Taiwan",
  "Singapore",
]);

/** tech-conferences/conference-data: open CFPs that are online or in East Asia. */
export function parseConferenceCfps(
  json: unknown,
  now: Date,
): CollectedEvent[] {
  const events: CollectedEvent[] = [];
  for (const item of Array.isArray(json) ? json : []) {
    const c = item as Record<string, unknown>;
    if (typeof c.name !== "string" || typeof c.cfpEndDate !== "string")
      continue;
    if (!(c.online === true || CFP_COUNTRIES.has(text(c.country)))) continue;
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.cfpEndDate);
    if (!date) continue;
    const startsAt = kstDate(Number(date[1]), Number(date[2]), Number(date[3]));
    if (startsAt.getTime() < now.getTime() - 86_400_000) continue;
    const url =
      typeof c.cfpUrl === "string"
        ? c.cfpUrl
        : typeof c.url === "string"
          ? c.url
          : null;
    events.push({
      externalKey: `cfp:${text(c.url) || c.name}:${c.cfpEndDate}`,
      source: "cfp",
      kind: "deadline",
      title: `[CFP] ${c.name} 발표 신청 마감`,
      startsAt,
      allDay: true,
      url,
      note:
        c.online === true ? "온라인" : `${text(c.city)}, ${text(c.country)}`,
    });
  }
  return events;
}

const CFP_TOPICS = [
  "general",
  "javascript",
  "typescript",
  "devops",
  "opensource",
  "security",
  "python",
  "rust",
  "data",
  "api",
];

/** Fetches every collector; one failing source does not drop the others. */
export async function fetchCollectedEvents(
  now = new Date(),
  get: (url: string) => Promise<string> = async (url) =>
    (
      await readSource(
        url,
        { "User-Agent": "rapi-agent" },
        { maxBodyBytes: 4_000_000 },
      )
    ).body,
): Promise<{ events: CollectedEvent[]; failures: string[] }> {
  const events: CollectedEvent[] = [];
  const failures: string[] = [];
  const attempt = async (
    name: string,
    work: () => Promise<CollectedEvent[]>,
  ) => {
    try {
      events.push(...(await work()));
    } catch (error) {
      failures.push(
        `${name}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  };
  await attempt("dev-event", async () =>
    parseDevEvent(
      await get(
        "https://raw.githubusercontent.com/brave-people/Dev-Event/master/README.md",
      ),
      now,
    ),
  );
  await attempt("devpost", async () =>
    parseDevpost(
      JSON.parse(
        await get(
          "https://devpost.com/api/hackathons?status[]=upcoming&status[]=open",
        ),
      ),
      now,
    ),
  );
  const year = new Date(now.getTime() + KST).getUTCFullYear();
  for (const y of [year, year + 1])
    for (const topic of CFP_TOPICS)
      await attempt(`cfp ${y}/${topic}`, async () => {
        try {
          return parseConferenceCfps(
            JSON.parse(
              await get(
                `https://raw.githubusercontent.com/tech-conferences/conference-data/main/conferences/${y}/${topic}.json`,
              ),
            ),
            now,
          );
        } catch (error) {
          // Next year's files appear gradually; a missing topic is not a failure.
          if (error instanceof Error && /404/.test(error.message)) return [];
          throw error;
        }
      });
  const unique = new Map(events.map((event) => [event.externalKey, event]));
  return { events: [...unique.values()], failures };
}
