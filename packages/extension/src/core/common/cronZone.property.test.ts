/**
 * A pipeline's schedule converted for a launcher's scheduler (`convertCronZone`
 * in shared) runs at the moments the editor's own triggers run it: the next
 * runs of the converted line, read by the parser the triggers use
 * (`nextCronRun`) in the scheduler's zone, are those of the pipeline's line
 * in its own zone — up to the first clock change that moves the two zones
 * apart, which the conversion names.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { convertCronZone } from '@sandforge/shared';

import { nextCronRun } from './cronSchedule';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Zones whose offsets differ by whole hours, half hours and three quarters, north and south. */
const ZONES = [
  'UTC',
  'Europe/Paris',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'America/St_Johns',
  'America/Sao_Paulo',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Chatham',
];

/** A winter and a summer instant, three weeks clear of any clock change of the zones above. */
const REFERENCES = [Date.parse('2027-01-14T12:00:00.000Z'), Date.parse('2027-07-14T12:00:00.000Z')];

/** The runs of a line in a zone after `after` and before `until`, twelve at most, as the triggers find them. */
function runsWithin(cron: string, zone: string, after: number, until: number): number[] {
  const runs: number[] = [];
  let from = after;
  while (runs.length < 12) {
    const next = nextCronRun(cron, zone, from);
    if (typeof next !== 'number' || next >= until) break;
    runs.push(next);
    from = next;
  }
  return runs;
}

/** A non-empty set of values of a field, written in order. */
const valuesOf = (min: number, max: number, most: number) =>
  fc
    .uniqueArray(fc.integer({ min, max }), { minLength: 1, maxLength: most })
    .map((values) => [...values].sort((a, b) => a - b).join(','));

const scheduleArb = fc.record({
  minutes: valuesOf(0, 59, 2),
  hours: valuesOf(0, 23, 3),
  daysOfWeek: fc.oneof(fc.constant('*'), valuesOf(0, 6, 3)),
  from: fc.constantFrom(...ZONES),
  to: fc.constantFrom(...ZONES),
  reference: fc.constantFrom(...REFERENCES),
});

describe("convertCronZone against the triggers' own parser", () => {
  it('converts a schedule into a line that runs at the same moments, or refuses it as no line can', () => {
    let converted = 0;
    fc.assert(
      fc.property(scheduleArb, ({ minutes, hours, daysOfWeek, from, to, reference }) => {
        const cron = `${minutes} ${hours} * * ${daysOfWeek}`;
        const result = convertCronZone(cron, from, to, reference);
        if ('refused' in result) {
          expect(result.refused).toBe('notExact');
          return;
        }
        converted += 1;
        const until = Math.min(result.offsetChanges[0]?.at ?? Infinity, reference + 20 * DAY_MS);
        const expected = runsWithin(cron, from, reference, until);
        expect(expected.length).toBeGreaterThan(0);
        expect(runsWithin(result.cron, to, reference, until)).toEqual(expected);
      }),
      { numRuns: 150, seed: 20261114 },
    );
    // The property holds of conversions, not of refusals alone.
    expect(converted).toBeGreaterThan(75);
  });

  it('names the clock change after which the converted line no longer runs at the same moments', () => {
    const reference = REFERENCES[0];
    const result = convertCronZone('0 2 * * *', 'Europe/Paris', 'UTC', reference);
    if ('refused' in result) throw new Error(result.reason);
    const [change] = result.offsetChanges;
    // From the day after it: the night of the change has no 02:00 in Paris.
    const from = change.at + DAY_MS;
    const pipeline = runsWithin('0 2 * * *', 'Europe/Paris', from, from + 3 * DAY_MS).slice(0, 3);
    const launcher = runsWithin(result.cron, 'UTC', from, from + 4 * DAY_MS).slice(0, 3);
    // Summer time in Paris: the launcher still starts at 01:00 UTC, which is
    // now 03:00 in Paris, an hour after the pipeline's schedule.
    expect(launcher.map((run, i) => run - pipeline[i])).toEqual([
      60 * 60 * 1000,
      60 * 60 * 1000,
      60 * 60 * 1000,
    ]);
    expect(change.offsetMinutes - result.offsetMinutes).toBe(-60);
  });
});
