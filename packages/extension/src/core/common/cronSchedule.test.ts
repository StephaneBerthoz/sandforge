import { describe, it, expect } from 'vitest';
import { nextCronRun, SCHEDULE_HORIZON_MS } from './cronSchedule';

const at = (iso: string): number => Date.parse(iso);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('nextCronRun', () => {
  it('gives the next time a schedule falls due, in the time zone it is read in', () => {
    const after = at('2026-09-23T10:00:00.000Z');
    expect(nextCronRun('0 9 * * 1', 'UTC', after)).toBe(at('2026-09-28T09:00:00.000Z'));
    // 02:00 in Paris is midnight UTC in September (summer time).
    expect(nextCronRun('0 2 * * *', 'Europe/Paris', after)).toBe(at('2026-09-24T00:00:00.000Z'));
  });

  it('never gives the instant it is asked from', () => {
    const due = at('2026-09-23T10:00:00.000Z');
    expect(nextCronRun('0 10 * * *', 'UTC', due)).toBe(at('2026-09-24T10:00:00.000Z'));
  });

  it('refuses a day none of its months has, instead of a date decades away', () => {
    // The parser accepts each field of this one, and used to answer 2054.
    const next = nextCronRun('0 0 31 2,4 *', 'UTC', at('2026-09-23T10:00:00.000Z'));
    expect(next).toEqual({ refused: 'noRunWithinYear', reason: expect.any(String) });
    const { reason } = next as { reason: string };
    expect(reason).toMatch(/No date in the coming year matches this cron expression/);
    expect(reason).toMatch(/31st of February or April/);
  });

  it('keeps a schedule that falls due once a year, on the day of the year farthest from it', () => {
    // A second after its run, the next one is a year away, across 29 February.
    const after = at('2027-03-01T00:00:01.000Z');
    const next = nextCronRun('0 0 1 3 *', 'UTC', after);
    expect(next).toBe(at('2028-03-01T00:00:00.000Z'));
    expect((next as number) - after).toBeGreaterThan(365 * DAY_MS);
    expect((next as number) - after).toBeLessThan(SCHEDULE_HORIZON_MS);
  });

  it('refuses 29 February while the next one is more than a year away, and gives it once it is not', () => {
    expect(nextCronRun('0 0 29 2 *', 'UTC', at('2026-09-23T10:00:00.000Z'))).toMatchObject({
      refused: 'noRunWithinYear',
    });
    expect(nextCronRun('0 0 29 2 *', 'UTC', at('2027-09-23T10:00:00.000Z'))).toBe(
      at('2028-02-29T00:00:00.000Z'),
    );
  });

  it('names a time zone it does not know, rather than blaming the expression', () => {
    // The parser reports such a zone as an error about a timestamp.
    expect(nextCronRun('0 9 * * 1', 'Mars/Olympus_Mons', at('2026-09-23T10:00:00.000Z'))).toEqual({
      refused: 'unknownTimezone',
      reason: 'SandForge does not know the time zone "Mars/Olympus_Mons".',
    });
  });

  it("says what the parser found wrong with an expression it cannot read, in the parser's words", () => {
    const after = at('2026-09-23T10:00:00.000Z');
    expect(nextCronRun('61 * * * *', 'UTC', after)).toEqual({
      refused: 'unreadable',
      reason: expect.stringMatching(/61/),
    });
    // A day no single month has is refused by the parser itself.
    expect(nextCronRun('0 0 30 2 *', 'UTC', after)).toEqual({
      refused: 'unreadable',
      reason: expect.stringMatching(/day of month/),
    });
  });
});
