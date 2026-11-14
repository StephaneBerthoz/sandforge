import { describe, expect, it } from 'vitest';

import {
  convertCronZone,
  readCron,
  zoneOffsetMinutes,
  type CronFields,
  type CronInZone,
  type CronZoneRefusal,
} from './cronZone.js';

const at = (iso: string): number => Date.parse(iso);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A winter instant, far from every clock change of the zones below. */
const JANUARY = at('2027-01-14T12:00:00.000Z');
/** A summer instant, as far from them. */
const JULY = at('2027-07-14T12:00:00.000Z');

function converted(result: CronInZone | CronZoneRefusal): CronInZone {
  if ('refused' in result) throw new Error(`${result.refused}: ${result.reason}`);
  return result;
}

function refusedWith(result: CronInZone | CronZoneRefusal): string {
  if (!('refused' in result)) throw new Error(`converted to ${result.cron}`);
  return result.refused;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** One formatter per zone: building one costs far more than reading a clock with it. */
const clocks = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of `zone` at `instant`: what a scheduler of that zone compares a cron with. */
function wallClock(zone: string, instant: number) {
  let clock = clocks.get(zone);
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      weekday: 'short',
      day: 'numeric',
      month: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    clocks.set(zone, clock);
  }
  const parts = clock.formatToParts(new Date(instant));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    minute: Number(part('minute')),
    hour: Number(part('hour')),
    day: Number(part('day')),
    month: Number(part('month')),
    weekday: WEEKDAYS[part('weekday')],
  };
}

/** Whether a cron's fields match a wall clock, read minute by minute: the oracle the conversion is held to. */
function matches(fields: CronFields, clock: ReturnType<typeof wallClock>): boolean {
  const inSet = (set: '*' | number[], value: number) => set === '*' || set.includes(value);
  return (
    fields.minutes.includes(clock.minute) &&
    fields.hours.includes(clock.hour) &&
    inSet(fields.daysOfMonth, clock.day) &&
    inSet(fields.months, clock.month) &&
    inSet(fields.daysOfWeek, clock.weekday)
  );
}

/** Every minute in [from, to) a cron falls due in `zone`, scanned one minute after another. */
function dueMinutes(cron: string, zone: string, from: number, to: number): number[] {
  const fields = readCron(cron);
  if ('refused' in fields) throw new Error(fields.reason);
  const due: number[] = [];
  for (let instant = from; instant < to; instant += MINUTE_MS) {
    if (matches(fields, wallClock(zone, instant))) due.push(instant);
  }
  return due;
}

/** A small generator with a seed, so a failure is found again on the next run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Zones whose offsets differ by whole hours, half hours and three quarters, north and south. */
const ZONES = [
  'UTC',
  'Europe/Paris',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'America/St_Johns',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Chatham',
];

describe('readCron', () => {
  it('reads the five fields, as numbers, a day of the week 7 read as Sunday', () => {
    expect(readCron('0,30 2-4 * * 1-5')).toEqual({
      minutes: [0, 30],
      hours: [2, 3, 4],
      daysOfMonth: '*',
      months: '*',
      daysOfWeek: [1, 2, 3, 4, 5],
    });
    expect(readCron('*/20 9 * JAN-MAR sun,7')).toEqual({
      minutes: [0, 20, 40],
      hours: [9],
      daysOfMonth: '*',
      months: [1, 2, 3],
      daysOfWeek: [0],
    });
    expect(readCron('0 9 1,15 * *')).toMatchObject({ daysOfMonth: [1, 15], daysOfWeek: '*' });
  });

  it('reads six fields as seconds first, and takes them at second 0 alone', () => {
    expect(readCron('0 15 2 * * *')).toMatchObject({ minutes: [15], hours: [2] });
    expect(readCron('30 15 2 * * *')).toEqual({
      refused: 'seconds',
      reason: expect.stringMatching(/whole minute/),
    });
  });

  it('refuses what crontab, Task Scheduler and GitHub Actions do not read, naming it', () => {
    for (const cron of ['0 2 L * *', '0 2 * * 1#2', '0 2 15W * *', 'H 2 * * *', '0 2 * * 5L']) {
      const read = readCron(cron);
      expect(refusedWith(read as CronZoneRefusal), cron).toBe('unreadable');
    }
    expect(readCron('61 2 * * *')).toEqual({
      refused: 'unreadable',
      reason: expect.stringMatching(/"61".*minute.*0-59/),
    });
    expect(readCron('0 2 * *')).toEqual({
      refused: 'unreadable',
      reason: expect.stringMatching(/five fields.*4/),
    });
  });

  it('refuses a line that names both days of the month and days of the week', () => {
    // The editor runs such a line on either day; crontab runs `*/10 * 1` on
    // both at once, as `*/10` starts with a star.
    for (const cron of ['0 2 1 * 1', '0 2 */10 * 1', '0 2 1,15 * 0-6']) {
      expect(readCron(cron), cron).toEqual({
        refused: 'eitherDay',
        reason: expect.stringMatching(/either/),
      });
    }
    expect(readCron('0 2 ? * MON')).toMatchObject({ daysOfMonth: '*', daysOfWeek: [1] });
  });
});

describe('zoneOffsetMinutes', () => {
  it("gives a zone's offset from UTC at an instant, summer and winter", () => {
    expect(zoneOffsetMinutes('Europe/Paris', JANUARY)).toBe(60);
    expect(zoneOffsetMinutes('Europe/Paris', JULY)).toBe(120);
    expect(zoneOffsetMinutes('America/New_York', JANUARY)).toBe(-300);
    expect(zoneOffsetMinutes('Asia/Kathmandu', JULY)).toBe(345);
    expect(zoneOffsetMinutes('UTC', JULY)).toBe(0);
  });
});

describe('convertCronZone', () => {
  it('writes a schedule of Paris for a scheduler in UTC, an hour behind in winter', () => {
    const result = converted(convertCronZone('0 2 * * *', 'Europe/Paris', 'UTC', JANUARY));
    expect(result.cron).toBe('0 1 * * *');
    expect(result.timezone).toBe('UTC');
    expect(result.offsetMinutes).toBe(-60);
  });

  it('names each clock change of the coming year after which the line runs an hour off', () => {
    const result = converted(convertCronZone('0 2 * * *', 'Europe/Paris', 'UTC', JANUARY));
    expect(result.offsetChanges).toEqual([
      { at: at('2027-03-28T01:00:00.000Z'), offsetMinutes: -120 },
      { at: at('2027-10-31T01:00:00.000Z'), offsetMinutes: -60 },
    ]);
  });

  it('leaves a schedule as it is when the two zones keep the same clock all year', () => {
    const same = converted(
      convertCronZone('*/15 9-17 * * 1-5', 'Europe/Paris', 'Europe/Paris', JULY),
    );
    expect(same).toEqual({
      cron: '*/15 9-17 * * 1-5',
      timezone: 'Europe/Paris',
      offsetMinutes: 0,
      offsetChanges: [],
    });
    const twin = converted(convertCronZone('0 2 * * *', 'Europe/Paris', 'Europe/Brussels', JULY));
    expect(twin).toMatchObject({ cron: '0 2 * * *', offsetChanges: [] });
  });

  it('writes names, a ?, a Sunday written 7 and seconds at 0 as every scheduler reads them', () => {
    const result = converted(convertCronZone('0 0 2 ? JAN SUN,7', 'UTC', 'UTC', JULY));
    expect(result.cron).toBe('0 2 * 1 0');
  });

  it('moves the day of the week with times that cross midnight', () => {
    // 01:30 on Monday in Paris is 00:30 on Monday in UTC in winter, and 23:30
    // on Sunday in summer.
    expect(converted(convertCronZone('30 1 * * 1', 'Europe/Paris', 'UTC', JANUARY)).cron).toBe(
      '30 0 * * 1',
    );
    expect(converted(convertCronZone('30 1 * * 1', 'Europe/Paris', 'UTC', JULY)).cron).toBe(
      '30 23 * * 0',
    );
    // 22:00 on Friday and Saturday in New York is 03:00 on Saturday and Sunday in UTC.
    expect(
      converted(convertCronZone('0 22 * * 5,6', 'America/New_York', 'UTC', JANUARY)).cron,
    ).toBe('0 3 * * 0,6');
  });

  it('moves the minutes with a zone half an hour or three quarters apart', () => {
    expect(converted(convertCronZone('0 9 * * *', 'UTC', 'Asia/Kolkata', JULY)).cron).toBe(
      '30 14 * * *',
    );
    expect(converted(convertCronZone('30 23 * * *', 'UTC', 'Asia/Kathmandu', JULY)).cron).toBe(
      '15 5 * * *',
    );
  });

  it('refuses times that fall on two days in the other zone, when the day of the week matters', () => {
    // 00:30 and 12:30 on Monday in Paris are 23:30 on Sunday and 11:30 on
    // Monday in UTC in winter: no line runs at both and at nothing else.
    const result = convertCronZone('30 0,12 * * 1', 'Europe/Paris', 'UTC', JANUARY);
    expect(refusedWith(result)).toBe('notExact');
    expect((result as CronZoneRefusal).reason).toMatch(/two days/);
    // Every day, the same two times convert.
    expect(converted(convertCronZone('30 0,12 * * *', 'Europe/Paris', 'UTC', JANUARY)).cron).toBe(
      '30 11,23 * * *',
    );
  });

  it("refuses a day of the month or a month that a time crossing midnight moves across a month's end", () => {
    expect(refusedWith(convertCronZone('0 0 1 * *', 'Europe/Paris', 'UTC', JANUARY))).toBe(
      'notExact',
    );
    expect(refusedWith(convertCronZone('0 0 * 6 *', 'Europe/Paris', 'UTC', JANUARY))).toBe(
      'notExact',
    );
    // Away from midnight, the day stays the day.
    expect(converted(convertCronZone('0 9 1 6 *', 'Europe/Paris', 'UTC', JANUARY)).cron).toBe(
      '0 8 1 6 *',
    );
  });

  it('refuses minutes that no longer go with every hour, once moved by a half hour', () => {
    // 02:00 and 02:30 in UTC are 07:30 and 08:00 in Kolkata.
    expect(refusedWith(convertCronZone('0,30 2 * * *', 'UTC', 'Asia/Kolkata', JULY))).toBe(
      'notExact',
    );
  });

  it('refuses a time zone it does not know, naming it', () => {
    expect(convertCronZone('0 2 * * *', 'Mars/Olympus_Mons', 'UTC', JULY)).toEqual({
      refused: 'unknownTimezone',
      reason: 'SandForge does not know the time zone "Mars/Olympus_Mons".',
    });
    expect(refusedWith(convertCronZone('0 2 * * *', 'UTC', 'Nowhere/Else', JULY))).toBe(
      'unknownTimezone',
    );
  });

  it('runs at the same moments as the schedule it converts, away from clock changes', () => {
    const random = seeded(20261114);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    let compared = 0;
    for (let round = 0; round < 60; round++) {
      const minutes = [...new Set([pick([0, 5, 15, 30, 45, 59]), pick([0, 20, 40])])].sort(
        (a, b) => a - b,
      );
      const hours = [...new Set([Math.floor(random() * 24), Math.floor(random() * 24)])].sort(
        (a, b) => a - b,
      );
      const days = random() < 0.4 ? '*' : [...new Set([pick([0, 1, 2, 3]), pick([4, 5, 6])])];
      const cron = `${minutes.join(',')} ${hours.join(',')} * * ${
        days === '*' ? '*' : days.join(',')
      }`;
      const from = pick(ZONES);
      const to = pick(ZONES);
      const reference = pick([JANUARY, JULY]);
      const result = convertCronZone(cron, from, to, reference);
      if ('refused' in result) {
        expect(result.refused, `${cron} ${from} -> ${to}`).toBe('notExact');
        continue;
      }
      compared += 1;
      const window: [number, number] = [reference, reference + 2 * DAY_MS];
      expect(
        dueMinutes(result.cron, to, ...window),
        `${cron} ${from} -> ${to}: ${result.cron}`,
      ).toEqual(dueMinutes(cron, from, ...window));
    }
    // Most of them convert: the comparison is not of refusals alone.
    expect(compared).toBeGreaterThan(30);
  });
});
