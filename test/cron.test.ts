import { describe, expect, it } from 'vitest';
import { CronError, nextOccurrence, parseCron } from '../src/modules/campaigns/cron.js';

const next = (cron: string, after: string, zone = 'Asia/Riyadh') =>
  nextOccurrence(parseCron(cron), new Date(after), zone)?.toISOString() ?? null;

describe('cron', () => {
  it('reads a Monday 10:00 in Riyadh as 07:00 UTC', () => {
    // 2026-09-24 is a Thursday.
    expect(next('0 10 * * 1', '2026-09-24T12:00:00Z')).toBe('2026-09-28T07:00:00.000Z');
  });

  it('is strictly after: the minute it fires is not the next one', () => {
    expect(next('0 10 * * 1', '2026-09-28T07:00:00Z')).toBe('2026-10-05T07:00:00.000Z');
    expect(next('*/1 * * * *', '2026-09-24T12:00:30Z')).toBe('2026-09-24T12:01:00.000Z');
  });

  it('handles steps, ranges and lists', () => {
    expect(next('*/15 9-17 * * *', '2026-09-24T06:50:00Z')).toBe('2026-09-24T07:00:00.000Z'); // 10:00 local
    expect(next('5,35 * * * *', '2026-09-24T12:10:00Z')).toBe('2026-09-24T12:35:00.000Z');
    expect(next('30 8 * * 0-4', '2026-09-25T00:00:00Z')).toBe('2026-09-27T05:30:00.000Z'); // Sunday
  });

  it('matches either day field when both are restricted', () => {
    // The 1st of the month, or any Friday: Friday 25 September comes first.
    expect(next('0 12 1 * 5', '2026-09-24T12:00:00Z')).toBe('2026-09-25T09:00:00.000Z');
  });

  it('skips a local time the clocks jump over', () => {
    // New York springs forward at 02:00 on 8 March 2026; 02:30 does not exist that day.
    expect(next('30 2 * * *', '2026-03-08T00:00:00Z', 'America/New_York')).toBe(
      '2026-03-09T06:30:00.000Z',
    );
  });

  it('finds a leap day, and says never for a date that does not exist', () => {
    expect(next('0 0 29 2 *', '2026-09-24T00:00:00Z', 'UTC')).toBe('2028-02-29T00:00:00.000Z');
    expect(next('0 0 31 2 *', '2026-09-24T00:00:00Z', 'UTC')).toBeNull();
  });

  it('treats 7 as Sunday', () => {
    expect(next('0 0 * * 7', '2026-09-24T00:00:00Z', 'UTC')).toBe('2026-09-27T00:00:00.000Z');
  });

  it('rejects what is not a standard five-field cron', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '0 0 0 * *', 'a * * * *', '*/0 * * * *', '@daily']) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }
  });
});
