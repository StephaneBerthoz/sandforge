import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LOADS_INDEX_FILE,
  auditedLoadsOf,
  indexLoad,
  indexedLoadsOf,
  lastWriteOfLoad,
  otherSasRunsOf,
  sasMarkOf,
} from './otherSasLoads.js';
import { inSweepWindow } from '../../bridge/handlers/removalSweep.js';

const ORG = '00D000000000009AAA';
const START = '2026-10-01T10:00:00.000Z';
const END = '2026-10-01T10:05:00.000Z';

describe('sasMarkOf', () => {
  it('names a sas by a digest of its folder, never the folder', () => {
    const mark = sasMarkOf('/home/someone/sas');

    expect(mark).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(mark).not.toContain('someone');
    expect(sasMarkOf('/home/someone/sas/')).toBe(mark);
    expect(sasMarkOf('/home/someone/other-sas')).not.toBe(mark);
  });
});

describe('otherSasRunsOf', () => {
  const own = [{ startedAt: START, endedAt: END }];

  it('counts a load another sas marked as a run of its own span, whose records it does not name', () => {
    expect(
      otherSasRunsOf([{ sas: 'sha256:b', startedAt: START, endedAt: END }], {
        sasMark: 'sha256:a',
        own,
      }),
    ).toEqual([{ ids: [], idsUntold: true, from: Date.parse(START), to: Date.parse(END) }]);
  });

  it('dates a load another sas marked by its last write, where it was recorded, and by its end otherwise', () => {
    // Run for real on the trap org: a load of another sas, ended 3 seconds
    // after its last write, was counted in the window of a load whose first
    // write came 64 seconds after that last write, and --sweep-untied was
    // refused by 1.1 seconds.
    const other = {
      sas: 'sha256:b',
      startedAt: '2026-11-04T12:11:40.000Z',
      endedAt: '2026-11-04T12:11:53.100Z',
    };
    const written = { first: '2026-11-04T12:12:54.000Z', last: '2026-11-04T12:12:55.000Z' };
    const runOf = (load: typeof other & { lastWriteAt?: string }) =>
      otherSasRunsOf([load], { sasMark: 'sha256:a', own: [] })[0];

    const byItsEnd = runOf(other);
    expect(byItsEnd.to).toBe(Date.parse(other.endedAt));
    expect(inSweepWindow(written, byItsEnd)).toBe(true);

    const byItsWrites = runOf({ ...other, lastWriteAt: '2026-11-04T12:11:50.000Z' });
    expect(byItsWrites).toEqual({
      ids: [],
      idsUntold: true,
      from: Date.parse(other.startedAt),
      to: Date.parse('2026-11-04T12:11:50.000Z'),
    });
    expect(inSweepWindow(written, byItsWrites)).toBe(false);
    // Within a minute of its last write, it is a run of the window still:
    // what its automation wrote after it may be there.
    expect(
      inSweepWindow({ first: '2026-11-04T12:12:51.000Z', last: written.last }, byItsWrites),
    ).toBe(true);
  });

  it('leaves out a load its own sas marked: its mapping names it', () => {
    expect(
      otherSasRunsOf([{ sas: 'sha256:a', startedAt: START, endedAt: END }], {
        sasMark: 'sha256:a',
        own: [],
      }),
    ).toEqual([]);
  });

  it('tells a load recorded before loads left a mark by when it ended: within a load of the sas, it is that load', () => {
    const runs = otherSasRunsOf(
      [{ endedAt: '2026-10-01T10:06:00.000Z' }, { endedAt: '2026-10-01T11:00:00.000Z' }],
      { sasMark: 'sha256:a', own },
    );

    expect(runs).toEqual([
      {
        ids: [],
        idsUntold: true,
        from: Date.parse('2026-10-01T11:00:00.000Z'),
        to: Date.parse('2026-10-01T11:00:00.000Z'),
      },
    ]);
  });
});

describe('lastWriteOfLoad', () => {
  it('gives the last write the mapping keeps of the load it recorded since this one began', () => {
    const recorded = {
      endedAt: '2026-10-01T10:05:03.000Z',
      writtenBetween: { first: '2026-10-01T10:04:00.000Z', last: '2026-10-01T10:04:59.000Z' },
    };

    expect(lastWriteOfLoad(recorded, START)).toBe('2026-10-01T10:04:59.000Z');
  });

  it('gives nothing of a load recorded before this one began, nor of one the target did not date', () => {
    const earlier = {
      endedAt: '2026-10-01T09:00:00.000Z',
      writtenBetween: { first: '2026-10-01T08:59:00.000Z', last: '2026-10-01T08:59:59.000Z' },
    };

    expect(lastWriteOfLoad(earlier, START)).toBeUndefined();
    expect(lastWriteOfLoad({ endedAt: END }, START)).toBeUndefined();
    expect(lastWriteOfLoad(undefined, START)).toBeUndefined();
  });
});

describe('auditedLoadsOf', () => {
  it('reads the loads that wrote, with their mark and start, and passes over the rest', () => {
    expect(
      auditedLoadsOf([
        {
          action: 'frozen_load',
          outcome: 'success',
          timestamp: END,
          details: { sas: 'sha256:b', startedAt: START, lastWriteAt: '2026-10-01T10:04:57.000Z' },
        },
        { action: 'frozen_load', outcome: 'stopped', timestamp: END, details: {} },
        { action: 'seed_execute', outcome: 'success', timestamp: END, details: {} },
        { action: 'frozen_load', outcome: 'failure', timestamp: END, details: {} },
      ]),
    ).toEqual([
      { sas: 'sha256:b', startedAt: START, endedAt: END, lastWriteAt: '2026-10-01T10:04:57.000Z' },
      { endedAt: END },
    ]);
  });
});

describe('the index of the command line’s loads', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-index-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps each load, and gives back those into an org, by either form of its id', () => {
    indexLoad(dir, { organizationId: ORG, sas: 'sha256:a', startedAt: START, endedAt: END });
    indexLoad(dir, { organizationId: '00D000000000002AAA', sas: 'sha256:a', endedAt: END });

    expect(indexedLoadsOf(dir, ORG.slice(0, 15))).toEqual([
      { sas: 'sha256:a', startedAt: START, endedAt: END },
    ]);
  });

  it('gives back the last write a load was indexed with', () => {
    const lastWriteAt = '2026-10-01T10:04:57.000Z';
    indexLoad(dir, {
      organizationId: ORG,
      sas: 'sha256:a',
      startedAt: START,
      endedAt: END,
      lastWriteAt,
    });

    expect(indexedLoadsOf(dir, ORG)).toEqual([
      { sas: 'sha256:a', startedAt: START, endedAt: END, lastWriteAt },
    ]);
  });

  it('passes over a line that does not read, and gives nothing without an index', () => {
    expect(indexedLoadsOf(dir, ORG)).toEqual([]);
    fs.writeFileSync(path.join(dir, LOADS_INDEX_FILE), `not json\n{"endedAt":1}\n`);
    indexLoad(dir, { organizationId: ORG, sas: 'sha256:b', endedAt: END });

    expect(indexedLoadsOf(dir, ORG)).toEqual([{ sas: 'sha256:b', endedAt: END }]);
  });
});
