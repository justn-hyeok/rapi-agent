import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseConferenceCfps,
  parseDevEvent,
  parseDevpost,
} from "@rapi/adapters";
import {
  formatScheduleWhen,
  parseScheduleText,
  scheduleDaysUntil,
} from "@rapi/core";

const now = new Date("2026-10-08T03:00:00Z"); // Thu 12:00 KST

function parsed(text: string): string {
  const result = parseScheduleText(text, now);
  return "error" in result
    ? `error`
    : `${formatScheduleWhen(result.startsAt, result.allDay)} ${result.title}`;
}

test("parses Korean schedule phrases in Asia/Seoul", () => {
  assert.equal(parsed("금요일 오후 3시 면담"), "10/9 (금) 15:00 면담");
  assert.equal(parsed("목요일 회의"), "10/8 (목) 회의");
  assert.equal(parsed("다음주 월요일 10시 반 회의"), "10/12 (월) 10:30 회의");
  assert.equal(parsed("다음주 목요일 리뷰"), "10/15 (목) 리뷰");
  assert.equal(parsed("10/20 해커톤 접수 마감"), "10/20 (화) 해커톤 접수 마감");
  // Already past this year, so it means next year (2027-10-03 is a Sunday).
  assert.equal(parsed("10월 3일 개천절"), "10/3 (일) 개천절");
  assert.equal(parsed("내일 15:30 치과"), "10/9 (금) 15:30 치과");
  assert.equal(parsed("모레 저녁 7시 저녁 약속"), "10/10 (토) 19:00 저녁 약속");
  assert.equal(parsed("3일 뒤 과제 제출"), "10/11 (일) 과제 제출");
  assert.equal(parsed("5일 정산"), "11/5 (목) 정산");
  assert.equal(
    parsed("2026-12-24 크리스마스 이브"),
    "12/24 (목) 크리스마스 이브",
  );
  assert.equal(parsed("그냥 메모"), "error");
  assert.equal(parsed("내일"), "error");
  assert.equal(parsed("2월 30일 없는 날"), "error");
  assert.equal(parsed("내일 25시 이상한 시간"), "error");
});

test("counts days until in local dates", () => {
  assert.equal(scheduleDaysUntil(new Date("2026-10-08T14:59:00Z"), now), 0);
  assert.equal(scheduleDaysUntil(new Date("2026-10-08T15:00:00Z"), now), 1);
});

test("collects contest deadlines from Dev-Event and skips webinars", () => {
  const markdown = [
    "## `26년 10월`",
    "- __[AI 해커톤](https://example.com/hack)__",
    "  - 분류: `온라인`, `무료`, `해커톤`, `AI`",
    "  - 주최: 누군가",
    "  - 접수: 09. 28(월) 10:00 ~ 10. 20(화) 18:00",
    "- __[웨비나](https://example.com/web)__",
    "  - 분류: `온라인`, `세미나`",
    "  - 접수: 10. 01(목) ~ 10. 10(토)",
    "- __[지난 대회](https://example.com/old)__",
    "  - 분류: `대회`",
    "  - 접수: 09. 01(화) ~ 10. 01(목)",
    "## `26년 12월`",
    "- __[겨울 컨퍼런스](https://example.com/conf)__",
    "  - 분류: `컨퍼런스`",
    "  - 일시: 12. 05(토)",
  ].join("\n");
  const events = parseDevEvent(markdown, now);
  assert.deepEqual(
    events.map((e) => [
      e.title,
      formatScheduleWhen(e.startsAt, e.allDay),
      e.kind,
    ]),
    [
      ["[해커톤] AI 해커톤 접수 마감", "10/20 (화) 18:00", "deadline"],
      ["[컨퍼런스] 겨울 컨퍼런스", "12/5 (토)", "event"],
    ],
  );
});

test("collects online AI hackathons from Devpost", () => {
  const events = parseDevpost(
    {
      hackathons: [
        {
          title: "AI Jam",
          url: "https://ai.devpost.com",
          submission_period_dates: "Sep 01 - Oct 23, 2026",
          displayed_location: { location: "Online" },
          themes: [{ name: "Machine Learning/AI" }],
        },
        {
          title: "Same Month",
          url: "https://m.devpost.com",
          submission_period_dates: "Oct 01 - 30, 2026",
          displayed_location: { location: "Online" },
          themes: [{ name: "AI" }],
        },
        {
          title: "Offline",
          url: "https://o.devpost.com",
          submission_period_dates: "Oct 01 - 30, 2026",
          displayed_location: { location: "Seoul" },
          themes: [{ name: "AI" }],
        },
        {
          title: "Web",
          url: "https://w.devpost.com",
          submission_period_dates: "Oct 01 - 30, 2026",
          displayed_location: { location: "Online" },
          themes: [{ name: "Web" }],
        },
      ],
    },
    now,
  );
  assert.deepEqual(
    events.map((e) => [e.title, formatScheduleWhen(e.startsAt, true)]),
    [
      ["[해커톤] AI Jam 제출 마감", "10/23 (금)"],
      ["[해커톤] Same Month 제출 마감", "10/30 (금)"],
    ],
  );
});

test("collects open CFPs that are online or in East Asia", () => {
  const events = parseConferenceCfps(
    [
      {
        name: "Online Conf",
        url: "https://a",
        cfpUrl: "https://a/cfp",
        cfpEndDate: "2026-10-30",
        online: true,
      },
      {
        name: "Tokyo Conf",
        url: "https://b",
        cfpEndDate: "2026-11-01",
        country: "Japan",
        city: "Tokyo",
      },
      {
        name: "Berlin Conf",
        url: "https://c",
        cfpEndDate: "2026-11-01",
        country: "Germany",
      },
      {
        name: "Closed",
        url: "https://d",
        cfpEndDate: "2026-09-01",
        online: true,
      },
    ],
    now,
  );
  assert.deepEqual(
    events.map((e) => [e.title, e.url]),
    [
      ["[CFP] Online Conf 발표 신청 마감", "https://a/cfp"],
      ["[CFP] Tokyo Conf 발표 신청 마감", "https://b"],
    ],
  );
});
