/**
 * MF2 unit tests: timezone-aware next-run computation for schedules
 * (cron + one-shot `at`), focused on the default Asia/Qatar zone (+03:00,
 * no DST) per the task spec. Pure module — no store access.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  atToUtcMs,
  initialNextRunAt,
  isValidTimezone,
  nextCronRun,
  nextOccurrenceAfter,
  parseCron,
  DEFAULT_TIMEZONE,
} from "../scheduleTime.js";

describe("schedule timezone math (Asia/Qatar)", () => {
  it("defaults to Asia/Qatar and validates IANA names", () => {
    assert.equal(DEFAULT_TIMEZONE, "Asia/Qatar");
    assert.equal(isValidTimezone("Asia/Qatar"), true);
    assert.equal(isValidTimezone("Not/AZone"), false);
  });

  it("computes a same-day cron occurrence in Asia/Qatar (+03:00)", () => {
    // 05:00 UTC = 08:00 Qatar; 09:30 Qatar == 06:30 UTC.
    const next = nextCronRun("30 9 * * *", new Date("2026-10-20T05:00:00.000Z"), "Asia/Qatar");
    assert.equal(next.toISOString(), "2026-10-20T06:30:00.000Z");
  });

  it("rolls to the next day when the local time already passed", () => {
    const before = nextCronRun("30 9 * * *", new Date("2026-10-20T06:29:00.000Z"), "Asia/Qatar");
    assert.equal(before.toISOString(), "2026-10-20T06:30:00.000Z");
    // Exactly at the occurrence: the next run is strictly after it.
    const atOccurrence = nextCronRun("30 9 * * *", new Date("2026-10-20T06:30:00.000Z"), "Asia/Qatar");
    assert.equal(atOccurrence.toISOString(), "2026-10-21T06:30:00.000Z");
    const after = nextCronRun("30 9 * * *", new Date("2026-10-20T06:31:00.000Z"), "Asia/Qatar");
    assert.equal(after.toISOString(), "2026-10-21T06:30:00.000Z");
  });

  it("honors day-of-week (0 = Sunday) across the UTC offset", () => {
    // 2026-10-20 is a Tuesday; next Sunday 00:00 Qatar = Oct 24 21:00 UTC.
    const next = nextCronRun("0 0 * * 0", new Date("2026-10-20T00:00:00.000Z"), "Asia/Qatar");
    assert.equal(next.toISOString(), "2026-10-24T21:00:00.000Z");
  });

  it("supports ranges, steps and lists", () => {
    // 05:00 UTC = 08:00 Qatar exactly; next */15 minute in 08-10h window: 08:15 local.
    const next = nextCronRun("*/15 8-10 * * 1-5", new Date("2026-10-20T05:00:00.000Z"), "Asia/Qatar");
    assert.equal(next.toISOString(), "2026-10-20T05:15:00.000Z");
    // Lists pick the exact minute.
    const listed = nextCronRun("0,45 9 * * *", new Date("2026-10-20T05:10:00.000Z"), "Asia/Qatar");
    assert.equal(listed.toISOString(), "2026-10-20T06:00:00.000Z"); // 09:00 Qatar
  });

  it("applies the dom OR dow rule when both are restricted", () => {
    // 13th of the month OR Friday, 09:00 Qatar. 2026-10-20 (Tue): next Friday is
    // Oct 23; the 13th already passed, so Friday wins -> Oct 23 06:00 UTC.
    const next = nextCronRun("0 9 13 * 5", new Date("2026-10-20T00:00:00.000Z"), "Asia/Qatar");
    assert.equal(next.toISOString(), "2026-10-23T06:00:00.000Z");
  });

  it("rejects invalid cron expressions and timezones", () => {
    assert.throws(() => parseCron("61 * * * *"), /range/);
    assert.throws(() => parseCron("* * *"), /5 fields/);
    assert.throws(() => parseCron("* * * * * *"), /5 fields/);
    assert.throws(() => nextCronRun("* * * * *", new Date(), "Not/AZone"), /timezone/);
  });

  it("reads offset-less `at` as wall time in the schedule timezone", () => {
    const ms = atToUtcMs("2026-10-21T09:00", "Asia/Qatar");
    assert.equal(new Date(ms).toISOString(), "2026-10-21T06:00:00.000Z");
    // Date-only means midnight in the zone.
    const midnight = atToUtcMs("2026-10-21", "Asia/Qatar");
    assert.equal(new Date(midnight).toISOString(), "2026-10-20T21:00:00.000Z");
  });

  it("keeps absolute ISO instants untouched", () => {
    const ms = atToUtcMs("2026-10-21T09:00:00Z", "Asia/Qatar");
    assert.equal(new Date(ms).toISOString(), "2026-10-21T09:00:00.000Z");
    const offset = atToUtcMs("2026-10-21T12:00:00+02:00", "Asia/Qatar");
    assert.equal(new Date(offset).toISOString(), "2026-10-21T10:00:00.000Z");
  });

  it("one-shot specs have no occurrence after their instant (null disables)", () => {
    const spec = { runAt: "2026-10-21T09:00", timezone: "Asia/Qatar" };
    assert.equal(nextOccurrenceAfter(spec, new Date("2026-10-20T00:00:00.000Z")), "2026-10-21T06:00:00.000Z");
    assert.equal(nextOccurrenceAfter(spec, new Date("2026-10-21T06:00:00.000Z")), null);
    assert.equal(nextOccurrenceAfter(spec, new Date("2026-10-22T00:00:00.000Z")), null);
  });

  it("past one-shots start immediately; future ones start at their instant", () => {
    const past = initialNextRunAt({ runAt: "2020-01-01T00:00" }, new Date("2026-10-20T00:00:00.000Z"));
    assert.equal(past, "2026-10-20T00:00:00.000Z");
    const future = initialNextRunAt({ runAt: "2026-10-21T09:00" }, new Date("2026-10-20T00:00:00.000Z"));
    assert.equal(future, "2026-10-21T06:00:00.000Z");
  });

  it("interval specs advance by the interval and cron specs by the expression", () => {
    assert.equal(initialNextRunAt({ intervalSeconds: 3600 }, new Date("2026-10-20T00:00:00.000Z")), "2026-10-20T01:00:00.000Z");
    assert.equal(initialNextRunAt({ cron: "30 9 * * *", timezone: "Asia/Qatar" }, new Date("2026-10-20T05:00:00.000Z")), "2026-10-20T06:30:00.000Z");
  });
});