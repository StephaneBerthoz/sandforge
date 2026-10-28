/**
 * Property-based tests of the marks the Seed, Sync and Forge histories put
 * on a run a rewind took back (`rewoundMarkOf`, shared): random checkpoints,
 * rewinds, clocks and runs, each run built in a zone of the rewind's bounds
 * on this machine's clock, its mark known by construction.
 *
 * Here and not beside the function: fast-check is this package's alone.
 * Each property sets `numRuns: 200`.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  REWOUND_MARGIN_MS,
  rewoundMarkOf,
  type CheckpointRewindEnded,
  type CheckpointRewindListed,
  type RewindStatus,
  type RewoundRun,
} from '@sandforge/shared';

const M = REWOUND_MARGIN_MS;
const MINUTE = 60_000;
const NOW = Date.parse('2026-12-31T00:00:00.000Z');
const ORG = 'org-dev';
const iso = (ms: number): string => new Date(ms).toISOString();

/** A rewind, on the org's clock, and its bounds on this machine's. */
interface Drawn {
  line: CheckpointRewindListed & CheckpointRewindEnded;
  t0: number;
  t1: number;
  tr: number;
  end: number;
}

const OBJECTS = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead'];

/**
 * A checkpoint taken over up to half an hour, a rewind to it up to three days
 * later lasting up to an hour, the org's clock up to ten minutes either side
 * of this machine's, and the gap between take and rewind at least five
 * margins: a run can fall between them.
 */
const rewindArb = (status: fc.Arbitrary<RewindStatus>): fc.Arbitrary<Drawn> =>
  fc
    .record({
      t0: fc.integer({
        min: Date.parse('2026-10-01T00:00:00Z'),
        max: Date.parse('2026-11-01T00:00:00Z'),
      }),
      take: fc.integer({ min: 0, max: 30 * MINUTE }),
      gap: fc.integer({ min: 5 * M, max: 3 * 24 * 60 * MINUTE }),
      length: fc.integer({ min: 0, max: 60 * MINUTE }),
      ahead: fc.integer({ min: -10 * MINUTE, max: 10 * MINUTE }),
      status,
      objects: fc.subarray(OBJECTS, { minLength: 1 }),
    })
    .map(({ t0, take, gap, length, ahead, status: drawn, objects }) => {
      const t1 = t0 + take;
      const tr = t1 + gap;
      const end = tr + length;
      return {
        t0,
        t1,
        tr,
        end,
        line: {
          kind: 'rewind',
          rewindId: 'rw-20261028-120000-aaaa',
          checkpointId: 'ck-20261028-100000-aaaa',
          checkpointName: 'Before UAT',
          organizationId: '00D000000000001AAA',
          mode: 'picked',
          objects,
          readFrom: iso(t0 + ahead),
          takenAt: iso(t1 + ahead),
          startedAt: iso(tr + ahead),
          endedAt: iso(end + ahead),
          orgAheadMs: ahead,
          status: drawn,
          totals: { deleted: 1, restored: 0, undeleted: 0, recreated: 0 },
          orgIds: [ORG],
        },
      };
    });

const wentThrough = fc.constantFrom<RewindStatus>('success', 'partial', 'unstable', 'failure');
const anyStatus = fc.constantFrom<RewindStatus>(
  'success',
  'partial',
  'unstable',
  'failure',
  'cancelled',
);

/** A run of the org from `start` for `length`, writing an object the checkpoint holds. */
const runOf = (drawn: Drawn, start: number, length: number): RewoundRun => ({
  orgId: ORG,
  startedAt: iso(start),
  endedAt: iso(start + length),
  objects: [drawn.line.objects[0] ?? 'Account'],
});

describe('rewoundMarkOf — property-based', () => {
  it('never marks a run that ended before the take began, less the margin: the checkpoint holds it', () => {
    fc.assert(
      fc.property(
        rewindArb(anyStatus),
        fc.integer({ min: 1, max: 30 * 24 * 60 * MINUTE }),
        fc.integer({ min: 0, max: 24 * 60 * MINUTE }),
        (drawn, before, length) => {
          const end = drawn.t0 - M - before;
          expect(
            rewoundMarkOf(runOf(drawn, end - length, length), [drawn.line], NOW),
          ).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('marks rewound whole a run between the end of the take and the start of the rewind, margins aside', () => {
    fc.assert(
      fc.property(
        rewindArb(wentThrough),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (drawn, at, share) => {
          const first = drawn.t1 + M + 1;
          const last = drawn.tr - M - 1;
          const start = first + Math.floor((last - first) * at);
          const length = Math.floor((last - start) * share);
          const mark = rewoundMarkOf(runOf(drawn, start, length), [drawn.line], NOW);
          expect(mark?.kind).toBe('rewound');
          expect(mark?.at).toBe(iso(drawn.end));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('marks in part a run that reaches into the take or into the rewind, margins included', () => {
    fc.assert(
      fc.property(
        rewindArb(wentThrough),
        fc.boolean(),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 6 * 60 * MINUTE }),
        fc.integer({ min: 0, max: 6 * 60 * MINUTE }),
        (drawn, take, at, before, after) => {
          const [from, to] = take ? [drawn.t0 - M, drawn.t1 + M] : [drawn.tr - M, drawn.end + M];
          const point = from + Math.floor((to - from) * at);
          const mark = rewoundMarkOf(
            runOf(drawn, point - before, before + after),
            [drawn.line],
            NOW,
          );
          expect(mark?.kind).toBe('partly');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never marks a run that began after the rewind ended, less the margin', () => {
    fc.assert(
      fc.property(
        rewindArb(anyStatus),
        fc.integer({ min: 1, max: 30 * 24 * 60 * MINUTE }),
        fc.integer({ min: 0, max: 24 * 60 * MINUTE }),
        (drawn, after, length) => {
          const start = drawn.end + M + after;
          expect(rewoundMarkOf(runOf(drawn, start, length), [drawn.line], NOW)).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('says stopped part way of a run any rewind stopped part way covers, and left some of one that left records', () => {
    fc.assert(
      fc.property(
        rewindArb(anyStatus),
        fc.integer({ min: 0, max: 3 * 24 * 60 * MINUTE }),
        fc.integer({ min: 0, max: 24 * 60 * MINUTE }),
        (drawn, offset, length) => {
          const mark = rewoundMarkOf(
            runOf(drawn, drawn.t0 - M + offset, length),
            [drawn.line],
            NOW,
          );
          if (mark === undefined) return;
          expect(mark.kind === 'stopped').toBe(drawn.line.status === 'cancelled');
          expect(mark.leftSome).toBe(
            ['partial', 'unstable', 'failure'].includes(drawn.line.status),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('marks a run the same whatever the org’s clock read, once the reading moves with it', () => {
    fc.assert(
      fc.property(
        rewindArb(anyStatus),
        fc.integer({ min: -60 * MINUTE, max: 60 * MINUTE }),
        fc.integer({ min: -2 * 24 * 60 * MINUTE, max: 5 * 24 * 60 * MINUTE }),
        fc.integer({ min: 0, max: 24 * 60 * MINUTE }),
        (drawn, shift, offset, length) => {
          const moved = (at: string): string => iso(Date.parse(at) + shift);
          const shifted: CheckpointRewindListed = {
            ...drawn.line,
            readFrom: moved(drawn.line.readFrom),
            takenAt: moved(drawn.line.takenAt),
            startedAt: moved(drawn.line.startedAt),
            endedAt: moved(drawn.line.endedAt),
            orgAheadMs: (drawn.line.orgAheadMs ?? 0) + shift,
          };
          const run = runOf(drawn, drawn.t0 + offset, length);
          expect(rewoundMarkOf(run, [shifted], NOW)).toEqual(rewoundMarkOf(run, [drawn.line], NOW));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never marks another org’s run, and says the undo of the rewind that marks one', () => {
    fc.assert(
      fc.property(
        rewindArb(wentThrough),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (drawn, at) => {
          const start = drawn.t1 + M + 1 + Math.floor((drawn.tr - drawn.t1 - 2 * M - 2) * at);
          const undone: CheckpointRewindListed = {
            kind: 'undo',
            rewindId: drawn.line.rewindId,
            checkpointId: drawn.line.checkpointId,
            organizationId: drawn.line.organizationId,
            status: 'success',
            undoneAt: iso(drawn.end + MINUTE),
            orgIds: [ORG],
          };
          const run = runOf(drawn, start, 0);
          expect(
            rewoundMarkOf({ ...run, orgId: 'org-other' }, [drawn.line, undone], NOW),
          ).toBeUndefined();
          expect(rewoundMarkOf(run, [drawn.line, undone], NOW)?.undoneAt).toBe(
            iso(drawn.end + MINUTE),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('names as outside exactly the run’s objects the checkpoint did not hold, and marks none when it held none', () => {
    fc.assert(
      fc.property(
        rewindArb(wentThrough),
        fc.subarray([...OBJECTS, 'Task'], { minLength: 1 }),
        (drawn, objects) => {
          const start = drawn.t1 + M + 1;
          const run: RewoundRun = { ...runOf(drawn, start, 0), objects };
          const held = new Set(drawn.line.objects);
          const outside = objects.filter((name) => !held.has(name));
          const mark = rewoundMarkOf(run, [drawn.line], NOW);
          if (outside.length === objects.length) expect(mark).toBeUndefined();
          else expect(mark?.outside).toEqual(outside);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('names the oldest of two rewinds that went through and cover a run: the later found its writes gone', () => {
    fc.assert(
      fc.property(
        rewindArb(wentThrough),
        fc.integer({ min: 0, max: 24 * 60 * MINUTE }),
        fc.boolean(),
        (drawn, later, reversed) => {
          const second: CheckpointRewindListed = {
            ...drawn.line,
            rewindId: 'rw-20261028-120000-bbbb',
            checkpointName: 'Later',
            startedAt: iso(Date.parse(drawn.line.endedAt) + later + 1),
            endedAt: iso(Date.parse(drawn.line.endedAt) + later + 2),
          };
          const run = runOf(drawn, drawn.t1 + M + 1, 0);
          const lines = reversed ? [second, drawn.line] : [drawn.line, second];
          expect(rewoundMarkOf(run, lines, NOW)?.checkpointName).toBe('Before UAT');
        },
      ),
      { numRuns: 200 },
    );
  });
});
