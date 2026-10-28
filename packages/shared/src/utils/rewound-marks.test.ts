import { describe, expect, it } from 'vitest';

import type {
  CheckpointRewindEnded,
  CheckpointRewindListed,
  CheckpointRewindUndone,
} from '../types/checkpoint.types.js';
import { REWOUND_MARGIN_MS, rewoundMarkOf, type RewoundRun } from './rewound-marks.js';

/*
 * A checkpoint taken from 10:00 to 10:05, org clock, and a rewind to it from
 * 12:00 to 12:10; the org's clock runs a minute ahead of this machine's,
 * which dates the runs. On this machine's clock the bounds are then 09:59,
 * 10:04, 11:59 and 12:09.
 */
const AHEAD = 60_000;
const at = (hhmm: string, offset = 0): string =>
  new Date(Date.parse(`2026-10-28T${hhmm}:00.000Z`) + offset).toISOString();
const ms = (iso: string): number => Date.parse(iso);
const M = REWOUND_MARGIN_MS;
const T0 = ms(at('09:59'));
const T1 = ms(at('10:04'));
const TR = ms(at('11:59'));
const END = ms(at('12:09'));
const NOW = ms(at('18:00'));

function rewind(change: Partial<CheckpointRewindEnded> = {}): CheckpointRewindListed {
  return {
    kind: 'rewind',
    rewindId: 'rw-20261028-120000-aaaa',
    checkpointId: 'ck-20261028-100000-aaaa',
    checkpointName: 'Before UAT',
    organizationId: '00D000000000001AAA',
    mode: 'picked',
    objects: ['Account', 'Contact'],
    readFrom: at('10:00'),
    takenAt: at('10:05'),
    startedAt: at('12:00'),
    endedAt: at('12:10'),
    orgAheadMs: AHEAD,
    status: 'success',
    totals: { deleted: 3, restored: 1, undeleted: 0, recreated: 0 },
    ...change,
    orgIds: ['org-dev'],
  } as CheckpointRewindListed;
}

function undo(change: Partial<CheckpointRewindUndone> = {}): CheckpointRewindListed {
  return {
    kind: 'undo',
    rewindId: 'rw-20261028-120000-aaaa',
    checkpointId: 'ck-20261028-100000-aaaa',
    organizationId: '00D000000000001AAA',
    status: 'success',
    undoneAt: at('13:00'),
    ...change,
    orgIds: ['org-dev'],
  } as CheckpointRewindListed;
}

/** A run of `org-dev` from `start` to `end`, machine clock, in milliseconds. */
function run(start: number, end: number, change: Partial<RewoundRun> = {}): RewoundRun {
  return {
    orgId: 'org-dev',
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    objects: ['Account'],
    ...change,
  };
}

describe('rewoundMarkOf', () => {
  it('marks rewound whole a run that wrote between the end of the take and the start of the rewind', () => {
    const mark = rewoundMarkOf(run(ms(at('11:00')), ms(at('11:05'))), [rewind()], NOW);

    expect(mark).toEqual({
      kind: 'rewound',
      rewindId: 'rw-20261028-120000-aaaa',
      checkpointId: 'ck-20261028-100000-aaaa',
      checkpointName: 'Before UAT',
      at: at('12:09'),
      leftSome: false,
      outside: [],
    });
  });

  it('never marks a run that ended before the take began: the checkpoint holds its records', () => {
    expect(rewoundMarkOf(run(ms(at('08:00')), T0 - M - 1), [rewind()], NOW)).toBeUndefined();
  });

  it('marks in part a run that reached the margin before the take, and one that ran as it was taken', () => {
    expect(rewoundMarkOf(run(ms(at('08:00')), T0 - M), [rewind()], NOW)?.kind).toBe('partly');
    expect(rewoundMarkOf(run(T0 + 1_000, T1 - 1_000), [rewind()], NOW)?.kind).toBe('partly');
  });

  it('holds each bound of the take and of the rewind to the millisecond', () => {
    const between = (start: number, end: number) =>
      rewoundMarkOf(run(start, end), [rewind()], NOW)?.kind;

    expect(between(T1 + M, TR - M - 1)).toBe('partly');
    expect(between(T1 + M + 1, TR - M - 1)).toBe('rewound');
    expect(between(T1 + M + 1, TR - M)).toBe('partly');
    // During the rewind, and up to its end and the margin after it.
    expect(between(TR, END)).toBe('partly');
    expect(between(END + M, END + M + 60_000)).toBe('partly');
    expect(between(END + M + 1, END + M + 60_000)).toBeUndefined();
  });

  it('reads the bounds on this machine’s clock through how far the org’s was ahead', () => {
    // The run ends on T0 less the margin, on this machine's clock.
    const edge = run(ms(at('08:00')), T0 - M);
    expect(rewoundMarkOf(edge, [rewind()], NOW)?.kind).toBe('partly');
    // The org a millisecond less ahead, T0 falls a millisecond later here: the run ended before.
    expect(rewoundMarkOf(edge, [rewind({ orgAheadMs: AHEAD - 1 })], NOW)).toBeUndefined();
    // A rewind that never read the org's clock reads the two as one: T0 a minute later still.
    expect(rewoundMarkOf(edge, [rewind({ orgAheadMs: undefined })], NOW)).toBeUndefined();
  });

  it('marks nothing on another org’s run', () => {
    const other = run(ms(at('11:00')), ms(at('11:05')), { orgId: 'org-other' });

    expect(rewoundMarkOf(other, [rewind(), undo()], NOW)).toBeUndefined();
  });

  it('dates to now a run still writing', () => {
    const writing: RewoundRun = { orgId: 'org-dev', startedAt: at('11:00'), objects: ['Account'] };

    expect(rewoundMarkOf(writing, [rewind()], ms(at('11:05')))?.kind).toBe('rewound');
    expect(rewoundMarkOf(writing, [rewind()], ms(at('12:00')))?.kind).toBe('partly');
  });

  it('says a rewind stopped part way, and one that left records', () => {
    const between = run(ms(at('11:00')), ms(at('11:05')));

    expect(rewoundMarkOf(between, [rewind({ status: 'cancelled' })], NOW)?.kind).toBe('stopped');
    for (const status of ['partial', 'unstable', 'failure'] as const) {
      expect(rewoundMarkOf(between, [rewind({ status })], NOW)?.leftSome).toBe(true);
    }
    expect(rewoundMarkOf(between, [rewind()], NOW)?.leftSome).toBe(false);
  });

  it('says when an undo took the rewind back', () => {
    const mark = rewoundMarkOf(run(ms(at('11:00')), ms(at('11:05'))), [rewind(), undo()], NOW);

    expect(mark?.undoneAt).toBe(at('13:00'));
  });

  it('reads the last line of a rewind taken up after a stop, under the same id', () => {
    const lines = [rewind({ status: 'cancelled' }), rewind({ status: 'success' })];

    expect(rewoundMarkOf(run(ms(at('11:00')), ms(at('11:05'))), lines, NOW)?.kind).toBe('rewound');
  });

  it('names the rewind that took the run’s writes back: the oldest gone through and not undone', () => {
    const between = run(ms(at('11:00')), ms(at('11:05')));
    const later = rewind({
      rewindId: 'rw-20261028-150000-bbbb',
      checkpointName: 'Earlier still',
      readFrom: at('09:00'),
      takenAt: at('09:01'),
      startedAt: at('15:00'),
      endedAt: at('15:05'),
    });

    expect(rewoundMarkOf(between, [rewind(), later], NOW)?.checkpointName).toBe('Before UAT');
    // Undone, the first gave the run's records back, and the second took them.
    expect(rewoundMarkOf(between, [rewind(), undo(), later], NOW)?.checkpointName).toBe(
      'Earlier still',
    );
    // Stopped part way, the first took some of them; the second, the rest.
    expect(
      rewoundMarkOf(between, [rewind({ status: 'cancelled' }), later], NOW)?.checkpointName,
    ).toBe('Earlier still');
    // Both undone: the latest says the records came back.
    const laterUndone = undo({ rewindId: 'rw-20261028-150000-bbbb', undoneAt: at('16:00') });
    const both = rewoundMarkOf(between, [rewind(), undo(), later, laterUndone], NOW);
    expect([both?.checkpointName, both?.undoneAt]).toEqual(['Earlier still', at('16:00')]);
  });

  it('names the run’s objects the checkpoint did not hold, whatever their case, and marks none when it held none of them', () => {
    const between = (objects: string[]) =>
      rewoundMarkOf(run(ms(at('11:00')), ms(at('11:05')), { objects }), [rewind()], NOW);

    expect(between(['account', 'Opportunity', 'Opportunity'])?.outside).toEqual(['Opportunity']);
    expect(between(['Opportunity', 'Case'])).toBeUndefined();
    // Unknown objects read as within the checkpoint.
    expect(between([])?.outside).toEqual([]);
  });

  it('marks nothing for a run or a rewind whose dates are not dates', () => {
    const between = run(ms(at('11:00')), ms(at('11:05')));

    expect(rewoundMarkOf({ ...between, startedAt: 'yesterday' }, [rewind()], NOW)).toBeUndefined();
    expect(rewoundMarkOf(between, [rewind({ endedAt: 'never' })], NOW)).toBeUndefined();
  });
});
