/**
 * A pipeline's schedule, written for a scheduler of another time zone.
 *
 * The editor reads a schedule in its own time zone. What starts a pipeline
 * once it is exported reads its line in another: cron in the machine's zone
 * (Ubuntu's cron has no `CRON_TZ`), GitHub Actions in UTC, Task Scheduler in
 * the machine's local time. The same line there runs at other moments, so it
 * is converted — or refused, when no single line there runs at the same
 * moments: times that fall on two days of the week once moved, a day of the
 * month that would cross a month's end, minutes that no longer go with every
 * hour.
 *
 * A conversion holds for one offset between the two zones: the one at the
 * instant it is made. Where either zone changes its clock, the converted line
 * runs an hour early or late from then on, and the conversion names each such
 * change of the coming year so the launcher can say so.
 *
 * Only what every one of those schedulers reads goes out: five fields of
 * numbers, `*`, ranges, steps and lists. Seconds, `L`, `W`, `#` and `H` —
 * which the editor's parser reads — are refused, and so is a line that names
 * both days of the month and days of the week: the editor runs it on either,
 * and cron, for a field written with a star, on both.
 */

/** What a cron expression says, field by field, as numbers; a day field written `*` stays `*`. */
export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: '*' | number[];
  months: '*' | number[];
  /** Sunday is 0; a 7 is read as 0. */
  daysOfWeek: '*' | number[];
}

/**
 * Why a schedule is not written for another zone:
 *
 * - `unknownTimezone`: a zone this runtime does not know.
 * - `unreadable`: a field no scheduler of a launcher reads, or a line that
 *   does not have five fields.
 * - `seconds`: a start past second 0 of a minute; none of them starts a run
 *   but on a whole minute.
 * - `eitherDay`: days of the month and days of the week both named.
 * - `notExact`: no single line in the other zone runs at the same moments.
 */
export type CronZoneRefusalCode =
  'unknownTimezone' | 'unreadable' | 'seconds' | 'eitherDay' | 'notExact';

/** A schedule refused, with why, in English. */
export interface CronZoneRefusal {
  refused: CronZoneRefusalCode;
  reason: string;
}

/** A clock change after which the converted line runs off: from `at`, the zones are `offsetMinutes` apart. */
export interface CronOffsetChange {
  at: number;
  offsetMinutes: number;
}

/** A schedule written for a scheduler of another zone. */
export interface CronInZone {
  /** Five fields, as cron, Task Scheduler's conversion and GitHub Actions read them. */
  cron: string;
  /** The zone it is read in. */
  timezone: string;
  /**
   * The minutes the target zone's clock is ahead of the source's, at the
   * instant the conversion was made: what the line was moved by.
   */
  offsetMinutes: number;
  /**
   * Each instant of the coming year at which the two zones' clocks move
   * apart or together, with how far apart they are from then: from each, the
   * line runs that much off what the pipeline's schedule says. Empty when the
   * two keep the same clocks all year.
   */
  offsetChanges: CronOffsetChange[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MINUTES = 24 * 60;

/** How far ahead the clock changes are named: a year, and a day for a schedule checked on the day after one. */
const HORIZON_MS = 367 * 24 * HOUR_MS;

/**
 * How often the offset between the two zones is read while looking for a
 * change: no zone changes its clock twice within six hours.
 */
const SAMPLE_MS = 6 * HOUR_MS;

/** A field of a cron line: its name, its bounds, and the names it takes for its values. */
interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  /** The value a name's first entry stands for: 1 for JAN, 0 for SUN. */
  namesFrom?: number;
}

const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59 };
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { name: 'day of the month', min: 1, max: 31 };
const MONTH: FieldSpec = {
  name: 'month',
  min: 1,
  max: 12,
  names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
  namesFrom: 1,
};
const DAY_OF_WEEK: FieldSpec = {
  name: 'day of the week',
  min: 0,
  max: 7,
  names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
  namesFrom: 0,
};

/** A part of a field every scheduler of a launcher reads as it is written: a number, a range, a star, with a step. */
const PORTABLE_PART = /^(?:\d+|(?:\*|\d+-\d+)(?:\/\d+)?)$/;

/** A field read: its values, whether it was written as a star, and whether it can go out as written. */
interface ReadField {
  values: number[];
  star: boolean;
  portable: boolean;
}

/** A value of a field, written as a number or a name. */
function valueOf(token: string, spec: FieldSpec): number | undefined {
  if (/^\d+$/.test(token)) return Number(token);
  const index = spec.names?.indexOf(token.toUpperCase()) ?? -1;
  return index >= 0 ? index + (spec.namesFrom ?? 0) : undefined;
}

/** A field read into its values, or why it does not read. */
function readField(text: string, spec: FieldSpec): ReadField | CronZoneRefusal {
  const unreadable = (part: string, why = ''): CronZoneRefusal => ({
    refused: 'unreadable',
    reason:
      `"${part}" is not a value of the ${spec.name} field, which runs ${spec.min}-${spec.max}` +
      `${why}.`,
  });
  if (text === '*' || text === '?') {
    // Sunday is 0 alone: 7 names it again.
    const max = spec === DAY_OF_WEEK ? 6 : spec.max;
    const values: number[] = [];
    for (let value = spec.min; value <= max; value++) values.push(value);
    return { values, star: true, portable: text === '*' };
  }
  const values = new Set<number>();
  let portable = true;
  for (const part of text.split(',')) {
    const match = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) {
      return unreadable(part, '; the schedulers a launcher uses do not read L, W, # or H');
    }
    const [, base, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return unreadable(part);
    let from: number | undefined;
    let to: number | undefined;
    if (base === '*') {
      from = spec.min;
      to = spec.max;
    } else {
      const [first, last] = base.split('-');
      from = valueOf(first, spec);
      // `5/15` runs from 5 to the end of the field, as the editor's parser reads it.
      to = last !== undefined ? valueOf(last, spec) : stepText !== undefined ? spec.max : from;
    }
    if (from === undefined || to === undefined) {
      return unreadable(part, '; the schedulers a launcher uses do not read L, W, # or H');
    }
    if (from < spec.min || to > spec.max || from > to) return unreadable(part);
    if (!PORTABLE_PART.test(part) || (spec === DAY_OF_WEEK && to === 7)) portable = false;
    for (let value = from; value <= to; value += step) {
      values.add(spec === DAY_OF_WEEK && value === 7 ? 0 : value);
    }
  }
  return { values: [...values].sort((a, b) => a - b), star: false, portable };
}

/** The five fields of a line read, with what each needs to go out again. */
interface ReadLine {
  minute: ReadField;
  hour: ReadField;
  dayOfMonth: ReadField;
  month: ReadField;
  dayOfWeek: ReadField;
  texts: string[];
}

function readLine(cron: string): ReadLine | CronZoneRefusal {
  let fields = cron.trim().split(/\s+/);
  if (fields.length === 6) {
    const seconds = fields[0];
    if (!/^0+$/.test(seconds)) {
      return {
        refused: 'seconds',
        reason:
          `It starts at second "${seconds}" of a minute; cron, Task Scheduler and GitHub Actions ` +
          'start a run on a whole minute. Set its seconds to 0.',
      };
    }
    fields = fields.slice(1);
  }
  if (fields.length !== 5) {
    return {
      refused: 'unreadable',
      reason: `A cron expression has five fields, or six with the seconds first; this one has ${fields.length}.`,
    };
  }
  const read: ReadField[] = [];
  for (const [index, spec] of [MINUTE, HOUR, DAY_OF_MONTH, MONTH, DAY_OF_WEEK].entries()) {
    const field = readField(fields[index], spec);
    if ('refused' in field) return field;
    read.push(field);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = read;
  if (!dayOfMonth.star && !dayOfWeek.star) {
    return {
      refused: 'eitherDay',
      reason:
        `It names both days of the month (${fields[2]}) and days of the week (${fields[4]}): ` +
        'SandForge runs it on either, and other schedulers read such a line their own way. ' +
        'Keep one of the two, and set the other to *.',
    };
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek, texts: fields };
}

/**
 * A cron expression read into its fields, as the schedulers a launcher uses
 * read it, or why they cannot: what an export reads a schedule with before it
 * writes a cron line, a Task Scheduler trigger or a workflow's schedule.
 */
export function readCron(cron: string): CronFields | CronZoneRefusal {
  const line = readLine(cron);
  if ('refused' in line) return line;
  return {
    minutes: line.minute.values,
    hours: line.hour.values,
    daysOfMonth: line.dayOfMonth.star ? '*' : line.dayOfMonth.values,
    months: line.month.star ? '*' : line.month.values,
    daysOfWeek: line.dayOfWeek.star ? '*' : line.dayOfWeek.values,
  };
}

/** The formatter that reads a zone's wall clock, one per zone. */
const wallClocks = new Map<string, Intl.DateTimeFormat>();

/** The formatter that reads `timezone`'s wall clock; throws for a zone the runtime does not know. */
function wallClockOf(timezone: string): Intl.DateTimeFormat {
  let format = wallClocks.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallClocks.set(timezone, format);
  }
  return format;
}

/** The zone's canonical name, or nothing for a zone this runtime does not know. */
function canonicalZone(timezone: string): string | undefined {
  try {
    return wallClockOf(timezone).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * How many minutes `timezone`'s clock is ahead of UTC at the instant `at`:
 * 60 for Paris in winter, -300 for New York, 345 for Kathmandu.
 */
export function zoneOffsetMinutes(timezone: string, at: number): number {
  const parts = wallClockOf(timezone).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return Math.round((wall - Math.floor(at / 1000) * 1000) / MINUTE_MS);
}

/** Each change of the coming year in how far apart two zones' clocks are. */
function offsetChangesOf(from: string, to: string, at: number): CronOffsetChange[] {
  const apart = (instant: number): number =>
    zoneOffsetMinutes(to, instant) - zoneOffsetMinutes(from, instant);
  const changes: CronOffsetChange[] = [];
  let before = at;
  let current = apart(at);
  for (let sample = at + SAMPLE_MS; sample <= at + HORIZON_MS; sample += SAMPLE_MS) {
    const now = apart(sample);
    if (now !== current) {
      // The first whole minute at which the new offset holds.
      let low = Math.floor(before / MINUTE_MS);
      let high = Math.ceil(sample / MINUTE_MS);
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (apart(middle * MINUTE_MS) === current) low = middle;
        else high = middle;
      }
      changes.push({ at: high * MINUTE_MS, offsetMinutes: now });
      current = now;
    }
    before = sample;
  }
  return changes;
}

/** A field's values as every scheduler reads them: a star for all of them, runs of three or more as ranges. */
function writeValues(values: readonly number[], spec: FieldSpec): string {
  const max = spec === DAY_OF_WEEK ? 6 : spec.max;
  if (values.length === max - spec.min + 1) return '*';
  const parts: string[] = [];
  for (let start = 0; start < values.length;) {
    let end = start;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end++;
    if (end - start >= 2) parts.push(`${values[start]}-${values[end]}`);
    else for (let index = start; index <= end; index++) parts.push(String(values[index]));
    start = end + 1;
  }
  return parts.join(',');
}

/** A field as it goes out: as written when every scheduler reads it so and its values did not move. */
function writeField(field: ReadField, text: string, values: readonly number[], spec: FieldSpec) {
  const same =
    values.length === field.values.length && values.every((value, i) => value === field.values[i]);
  return same && field.portable ? text : writeValues(values, spec);
}

/**
 * A pipeline's schedule, read in `from`, written for a scheduler that reads
 * its line in `to`, at the offset between the two at the instant `at`; or
 * why no single line there runs at the same moments.
 *
 * @param cron - The schedule, as the pipeline saved it.
 * @param from - The IANA zone the pipeline's schedule is read in.
 * @param to - The IANA zone the scheduler reads its line in.
 * @param at - Epoch milliseconds: the instant whose offset the line is moved by, as a rule now.
 */
export function convertCronZone(
  cron: string,
  from: string,
  to: string,
  at: number,
): CronInZone | CronZoneRefusal {
  for (const zone of [from, to]) {
    if (canonicalZone(zone) === undefined) {
      return {
        refused: 'unknownTimezone',
        reason: `SandForge does not know the time zone "${zone}".`,
      };
    }
  }
  const line = readLine(cron);
  if ('refused' in line) return line;
  const sameZone = canonicalZone(from) === canonicalZone(to);
  const offsetMinutes = sameZone ? 0 : zoneOffsetMinutes(to, at) - zoneOffsetMinutes(from, at);
  const offsetChanges = sameZone ? [] : offsetChangesOf(from, to, at);

  // Each time of day it names, moved by the offset, with the days it moved by.
  const moved: Array<{ minute: number; hour: number; days: number }> = [];
  for (const hour of line.hour.values) {
    for (const minute of line.minute.values) {
      const total = hour * 60 + minute + offsetMinutes;
      const days = Math.floor(total / DAY_MINUTES);
      const ofDay = total - days * DAY_MINUTES;
      moved.push({ minute: ofDay % 60, hour: Math.floor(ofDay / 60), days });
    }
  }

  const everyDay = line.dayOfMonth.star && line.month.star && line.dayOfWeek.values.length === 7;
  let dayOfWeek = line.dayOfWeek.values;
  const shifts = new Set(moved.map((time) => time.days));
  if (!everyDay) {
    if (shifts.size > 1) {
      return {
        refused: 'notExact',
        reason:
          `At the times it names, the clock of ${to} is on two days, and a line there cannot ` +
          'follow the days it runs on: no single line runs at the same moments. Choose times ' +
          `that stay on one day in ${to}, or run it every day.`,
      };
    }
    const [shift] = shifts;
    if (shift !== 0 && (!line.dayOfMonth.star || !line.month.star)) {
      return {
        refused: 'notExact',
        reason:
          `At the times it names, the clock of ${to} is on another day, and its day of the ` +
          "month or its month would move across a month's end: no single line runs at the same " +
          `moments. Choose times that stay on the same day in ${to}.`,
      };
    }
    if (shift !== 0 && !line.dayOfWeek.star) {
      dayOfWeek = [...new Set(dayOfWeek.map((day) => (((day + shift) % 7) + 7) % 7))].sort(
        (a, b) => a - b,
      );
    }
  }

  const minutes = [...new Set(moved.map((time) => time.minute))].sort((a, b) => a - b);
  const hours = [...new Set(moved.map((time) => time.hour))].sort((a, b) => a - b);
  if (minutes.length * hours.length !== moved.length) {
    return {
      refused: 'notExact',
      reason:
        `In ${to}, its minutes no longer go with each of its hours (the zones are ` +
        `${offsetMinutes} minutes apart): no single line runs at the same moments. Name one ` +
        'minute, or one hour.',
    };
  }

  const [minuteText, hourText, dayOfMonthText, monthText, dayOfWeekText] = line.texts;
  const fields = [
    writeField(line.minute, minuteText, minutes, MINUTE),
    writeField(line.hour, hourText, hours, HOUR),
    line.dayOfMonth.star
      ? '*'
      : writeField(line.dayOfMonth, dayOfMonthText, line.dayOfMonth.values, DAY_OF_MONTH),
    line.month.star ? '*' : writeField(line.month, monthText, line.month.values, MONTH),
    line.dayOfWeek.star ? '*' : writeField(line.dayOfWeek, dayOfWeekText, dayOfWeek, DAY_OF_WEEK),
  ];
  return { cron: fields.join(' '), timezone: to, offsetMinutes, offsetChanges };
}
