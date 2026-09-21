import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deliveryPeriodKey,
  deliveryPeriodWindow,
} from "../packages/core/src/domain/delivery-period.js";

describe("deliveryPeriodKey", () => {
  it("returns the local date at the UTC/Seoul day boundary", () => {
    const now = new Date("2026-09-21T16:00:00Z");
    assert.equal(deliveryPeriodKey(now, "daily", "UTC"), "2026-09-21");
    assert.equal(deliveryPeriodKey(now, "daily", "Asia/Seoul"), "2026-09-22");
  });

  it("returns the same Monday for a weekly period on Monday in Seoul", () => {
    const monday = new Date("2026-09-21T10:00:00+09:00");
    assert.equal(
      deliveryPeriodKey(monday, "weekly", "Asia/Seoul"),
      "2026-09-21",
    );
    const wednesday = new Date("2026-09-23T10:00:00+09:00");
    assert.equal(
      deliveryPeriodKey(wednesday, "weekly", "Asia/Seoul"),
      "2026-09-21",
    );
  });

  it("returns the prior Monday for a weekly period on Sunday in Seoul", () => {
    const sunday = new Date("2026-09-27T23:30:00+09:00");
    assert.equal(
      deliveryPeriodKey(sunday, "weekly", "Asia/Seoul"),
      "2026-09-21",
    );
  });

  it("throws on an invalid time zone", () => {
    assert.throws(
      () => deliveryPeriodKey(new Date(), "daily", "Not/AZone"),
      RangeError,
    );
  });

  it("uses half-open local day windows in UTC and Seoul", () => {
    const utc = deliveryPeriodWindow(
      new Date("2026-09-21T16:00:00Z"),
      "daily",
      "UTC",
    );
    assert.deepEqual(
      [utc.key, utc.start.toISOString(), utc.end.toISOString()],
      ["2026-09-21", "2026-09-21T00:00:00.000Z", "2026-09-22T00:00:00.000Z"],
    );
    const seoul = deliveryPeriodWindow(
      new Date("2026-09-21T16:00:00Z"),
      "daily",
      "Asia/Seoul",
    );
    assert.deepEqual(
      [seoul.key, seoul.start.toISOString(), seoul.end.toISOString()],
      ["2026-09-22", "2026-09-21T15:00:00.000Z", "2026-09-22T15:00:00.000Z"],
    );
  });

  it("uses a Monday-start weekly window in Seoul", () => {
    const period = deliveryPeriodWindow(
      new Date("2026-09-27T23:30:00+09:00"),
      "weekly",
      "Asia/Seoul",
    );
    assert.deepEqual(
      [period.key, period.start.toISOString(), period.end.toISOString()],
      ["2026-09-21", "2026-09-20T15:00:00.000Z", "2026-09-27T15:00:00.000Z"],
    );
  });
});
