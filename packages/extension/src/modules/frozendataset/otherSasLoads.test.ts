import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LOADS_INDEX_FILE,
  auditedLoadsOf,
  indexLoad,
  indexedLoadsOf,
  otherSasRunsOf,
  sasMarkOf,
} from './otherSasLoads.js';

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

describe('auditedLoadsOf', () => {
  it('reads the loads that wrote, with their mark and start, and passes over the rest', () => {
    expect(
      auditedLoadsOf([
        {
          action: 'frozen_load',
          outcome: 'success',
          timestamp: END,
          details: { sas: 'sha256:b', startedAt: START },
        },
        { action: 'frozen_load', outcome: 'stopped', timestamp: END, details: {} },
        { action: 'seed_execute', outcome: 'success', timestamp: END, details: {} },
        { action: 'frozen_load', outcome: 'failure', timestamp: END, details: {} },
      ]),
    ).toEqual([{ sas: 'sha256:b', startedAt: START, endedAt: END }, { endedAt: END }]);
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

  it('passes over a line that does not read, and gives nothing without an index', () => {
    expect(indexedLoadsOf(dir, ORG)).toEqual([]);
    fs.writeFileSync(path.join(dir, LOADS_INDEX_FILE), `not json\n{"endedAt":1}\n`);
    indexLoad(dir, { organizationId: ORG, sas: 'sha256:b', endedAt: END });

    expect(indexedLoadsOf(dir, ORG)).toEqual([{ sas: 'sha256:b', endedAt: END }]);
  });
});
