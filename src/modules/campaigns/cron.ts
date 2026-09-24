/**
 * Standard five-field cron, and the next time it fires in a time zone.
 *
 * Hand-written rather than a dependency: the brief allows plain 5-field crons
 * only (minute hour day-of-month month day-of-week; numbers, `*`, lists,
 * ranges and steps), and the one hard part, wall-clock time in a zone, is what
 * Intl already knows.
 */

export type Cron = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Classic cron: when both day fields are restricted, either may match. */
  domRestricted: boolean;
  dowRestricted: boolean;
};

export class CronError extends Error {}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`cron needs five fields (minute hour day month weekday), got ${parts.length}`);
  }

  const sets = parts.map((part, i) => parseField(part, FIELDS[i]!));
  const daysOfWeek = new Set([...sets[4]!].map((d) => (d === 7 ? 0 : d)));

  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    daysOfMonth: sets[2]!,
    months: sets[3]!,
    daysOfWeek,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

function parseField(field: string, spec: { name: string; min: number; max: number }): Set<number> {
  const values = new Set<number>();

  for (const item of field.split(',')) {
    const [range, stepText] = item.split('/');
    const step = stepText === undefined ? 1 : int(stepText, spec.name);
    if (step < 1) throw new CronError(`${spec.name}: step must be at least 1`);

    let from: number;
    let to: number;
    if (range === '*') {
      from = spec.min;
      to = spec.max;
    } else if (range?.includes('-')) {
      const [a, b] = range.split('-');
      from = int(a ?? '', spec.name);
      to = int(b ?? '', spec.name);
    } else {
      from = int(range ?? '', spec.name);
      // `5/15` means from 5 to the end, every 15.
      to = stepText === undefined ? from : spec.max;
    }

    if (from < spec.min || to > spec.max || from > to) {
      throw new CronError(`${spec.name}: ${item} is outside ${spec.min}-${spec.max}`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }

  return values;
}

function int(text: string, field: string): number {
  if (!/^\d+$/.test(text)) throw new CronError(`${field}: "${text}" is not a number`);
  return Number(text);
}

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Far enough to find a 29 February, and no further. */
const SEARCH_DAYS = 366 * 5;

/**
 * The first time strictly after `after` that the cron fires, read in `timeZone`
 * wall-clock time. Null when it never fires (a 31 February, say).
 *
 * A local time that does not exist, because the clocks jumped over it, is
 * skipped. One that happens twice fires on the first.
 */
export function nextOccurrence(cron: Cron, after: Date, timeZone: string): Date | null {
  const start = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE);
  const local = wallClock(start, timeZone);
  const firstDay = Date.UTC(local.year, local.month - 1, local.day);

  const hours = [...cron.hours].sort((a, b) => a - b);
  const minutes = [...cron.minutes].sort((a, b) => a - b);

  for (let d = 0; d < SEARCH_DAYS; d += 1) {
    const day = new Date(firstDay + d * DAY);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    if (!cron.months.has(month) || !dayMatches(cron, date, day.getUTCDay())) continue;

    for (const hour of hours) {
      if (d === 0 && hour < local.hour) continue;
      for (const minute of minutes) {
        if (d === 0 && hour === local.hour && minute < local.minute) continue;

        const instant = fromWallClock({ year, month, day: date, hour, minute }, timeZone);
        if (instant.getTime() <= after.getTime()) continue;

        // Round-trip: a time inside a DST gap comes back as some other time.
        const check = wallClock(instant, timeZone);
        if (check.hour !== hour || check.minute !== minute || check.day !== date) continue;

        return instant;
      }
    }
  }

  return null;
}

function dayMatches(cron: Cron, dayOfMonth: number, dayOfWeek: number): boolean {
  const dom = cron.daysOfMonth.has(dayOfMonth);
  const dow = cron.daysOfWeek.has(dayOfWeek);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

export function wallClock(at: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function offsetAt(instant: number, timeZone: string): number {
  const w = wallClock(new Date(instant), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(instant / MINUTE) * MINUTE;
}

function fromWallClock(w: WallClock, timeZone: string): Date {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const first = naive - offsetAt(naive, timeZone);
  const second = naive - offsetAt(first, timeZone);
  return new Date(second);
}

/** True when Intl knows the zone. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
