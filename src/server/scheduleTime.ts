/**
 * Schedule time semantics (MF2): IANA timezones, cron expressions and one-shot
 * `at` instants for agent routines. Pure functions with no store access, so the
 * timezone math stays unit-testable in isolation.
 *
 * Cron is the standard 5-field syntax (minute hour day-of-month month
 * day-of-week) with `*`, lists, ranges and steps. Wall-clock times are
 * evaluated in the schedule's timezone (default Asia/Qatar) and converted to
 * the UTC instants the scheduler stores in nextRunAt.
 */

/** Default schedule timezone (MF2 task spec). */
export const DEFAULT_TIMEZONE = "Asia/Qatar";

/** Delay before the single retry of a failed run (task spec: ~2 minutes). */
export const DEFAULT_RETRY_DELAY_MS = 120_000;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function requireTimezone(tz: string): void {
  if (!isValidTimezone(tz)) throw new Error(`unknown IANA timezone: ${tz}`);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let dtf = formatters.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, dtf);
  }
  return dtf;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of a UTC instant as seen in `tz`. */
function zonedParts(atUtcMs: number, tz: string): ZonedParts {
  const parts = zoneFormatter(tz).formatToParts(new Date(atUtcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `tz` from UTC at the given instant, in milliseconds. */
function zoneOffsetMs(atUtcMs: number, tz: string): number {
  const p = zonedParts(atUtcMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - atUtcMs;
}

/** UTC instant of a wall-clock time in `tz` (two-pass offset resolution). */
function wallTimeToUtcMs(year: number, month: number, day: number, hour: number, minute: number, second: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = wall - zoneOffsetMs(wall, tz);
  utc = wall - zoneOffsetMs(utc, tz);
  return utc;
}

interface CronField {
  /** True when the field matches every possible value (no restriction). */
  any: boolean;
  values: Set<number>;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7],  // day of week (0 and 7 = Sunday)
];

function parseCronField(raw: string, index: number): CronField {
  const [min, max] = FIELD_RANGES[index]!;
  const values = new Set<number>();
  if (!raw || !raw.trim()) throw new Error(`cron field ${index + 1} is empty`);
  for (const part of raw.split(",")) {
    const [rangePartRaw, stepPart] = part.split("/");
    const rangePart = rangePartRaw ?? "";
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step in "${raw}"`);
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const pieces = rangePart.split("-");
      if (pieces.length !== 2) throw new Error(`invalid cron range "${rangePart}"`);
      lo = Number(pieces[0]);
      hi = Number(pieces[1]);
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron value out of range in "${raw}" (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(index === 4 && v === 7 ? 0 : v);
  }
  return { any: values.size >= max - min + 1 - (index === 4 ? 1 : 0), values };
}

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
  domAny: boolean;
  dowAny: boolean;
}

/** Parse a 5-field cron expression (throws with a clear message when invalid). */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  }
  const [minutes, hours, doms, months, dows] = fields.map((f, i) => parseCronField(f, i)) as [CronField, CronField, CronField, CronField, CronField];
  const sorted = (f: CronField): number[] => [...f.values].sort((a, b) => a - b);
  return {
    minutes: sorted(minutes),
    hours: sorted(hours),
    doms: sorted(doms),
    months: sorted(months),
    dows: sorted(dows),
    domAny: doms.any,
    dowAny: dows.any,
  };
}

/** Next UTC instant strictly after `from` matching the cron in `timezone`. */
export function nextCronRun(cron: string, from: Date, timezone = DEFAULT_TIMEZONE): Date {
  const parsed = parseCron(cron);
  requireTimezone(timezone);
  const fromMs = from.getTime();
  const start = zonedParts(fromMs, timezone);
  // Walk local days (noon-anchored to stay clear of DST edges); 400 days
  // covers every calendar shape including leap-year-only crons.
  for (let dayOffset = 0; dayOffset < 400; dayOffset++) {
    const anchor = new Date(Date.UTC(start.year, start.month - 1, start.day, 12) + dayOffset * 86_400_000);
    const year = anchor.getUTCFullYear();
    const month = anchor.getUTCMonth() + 1;
    const day = anchor.getUTCDate();
    if (!parsed.months.includes(month)) continue;
    const dow = anchor.getUTCDay();
    const domOk = parsed.doms.includes(day);
    const dowOk = parsed.dows.includes(dow);
    // Standard cron rule: when both dom and dow are restricted, either may match.
    const dayOk = parsed.domAny && parsed.dowAny ? true : parsed.domAny ? dowOk : parsed.dowAny ? domOk : domOk || dowOk;
    if (!dayOk) continue;
    for (const hour of parsed.hours) {
      for (const minute of parsed.minutes) {
        const ms = wallTimeToUtcMs(year, month, day, hour, minute, 0, timezone);
        if (ms > fromMs) return new Date(ms);
      }
    }
  }
  throw new Error(`cron expression "${cron}" has no matching time within a year`);
}

/**
 * Parse a one-shot `at` instant. Strings with an explicit UTC offset are used
 * as-is; offset-less strings (e.g. "2026-10-21T09:00" or a bare date) are read
 * as wall-clock time in `timezone`.
 */
export function atToUtcMs(at: string, timezone = DEFAULT_TIMEZONE): number {
  const trimmed = at.trim();
  if (!trimmed) throw new Error("at must be a non-empty ISO time");
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) throw new Error(`invalid ISO time: ${at}`);
    return ms;
  }
  requireTimezone(timezone);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (!m) throw new Error(`invalid at time (expected ISO like 2026-10-21T09:00): ${at}`);
  return wallTimeToUtcMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), timezone);
}

/** Timing fields every schedule carries (cron/one-shot/interval). */
export interface ScheduleTiming {
  cron?: string;
  runAt?: string;
  intervalSeconds?: number;
  timezone?: string;
}

function effectiveTimezone(tz: string | undefined): string {
  const trimmed = tz?.trim();
  if (!trimmed) return DEFAULT_TIMEZONE;
  requireTimezone(trimmed);
  return trimmed;
}

/**
 * Next occurrence strictly after `from` (ISO string), or null when the spec
 * has no future occurrence — a spent one-shot. The caller then disables the
 * schedule or schedules a retry.
 */
export function nextOccurrenceAfter(timing: ScheduleTiming, from: Date): string | null {
  const tz = effectiveTimezone(timing.timezone);
  if (timing.cron) return nextCronRun(timing.cron, from, tz).toISOString();
  if (timing.runAt) {
    const atMs = atToUtcMs(timing.runAt, tz);
    if (atMs > from.getTime()) return new Date(atMs).toISOString();
    return null;
  }
  const interval = Math.max(30, Math.floor(timing.intervalSeconds ?? 3600));
  return new Date(from.getTime() + interval * 1000).toISOString();
}

/** First nextRunAt for a freshly created schedule (past one-shots are due now). */
export function initialNextRunAt(timing: ScheduleTiming, now: Date): string {
  const tz = effectiveTimezone(timing.timezone);
  if (timing.runAt && !timing.cron) {
    const atMs = atToUtcMs(timing.runAt, tz);
    return new Date(Math.max(atMs, now.getTime())).toISOString();
  }
  return nextOccurrenceAfter(timing, now) ?? now.toISOString();
}