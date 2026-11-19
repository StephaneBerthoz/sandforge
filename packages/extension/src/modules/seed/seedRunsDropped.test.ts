import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SEED_RUNS_DROPPED_FILE,
  SeedRunsDropped,
  droppedCleanupLine,
  nodeSeedRunsDropped,
} from './seedRunsDropped';
import { seedRunKept } from './SeedRunCreations';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** A seed of two accounts and a contact under one, removed in part, or not at all. */
function seed(runId: string, startedAt = '2026-11-02T23:40:00.000Z') {
  return seedRunKept({
    runId,
    targetOrgId: 'org-target',
    startedAt,
    finishedAt: '2026-11-03T00:05:00.000Z',
    status: 'success',
    objectResults: [
      { objectApiName: 'Account', createdIds: [fakeId('001', 1), fakeId('001', 2)] },
      { objectApiName: 'Contact', createdIds: [fakeId('003', 1)] },
    ],
  });
}

describe('the Seed runs the bound on their files dropped', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-dropped-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps of a dropped run what a removal would have taken, per object the last written first, and when, read back after a reload', async () => {
    await nodeSeedRunsDropped(dir).note(seed('op-big'), '2026-11-18T09:00:00.000Z');

    expect(await nodeSeedRunsDropped(dir).find('op-big')).toEqual({
      runId: 'op-big',
      targetOrgId: 'org-target',
      startedAt: '2026-11-02T23:40:00.000Z',
      droppedAt: '2026-11-18T09:00:00.000Z',
      left: [
        { objectApiName: 'Contact', count: 1 },
        { objectApiName: 'Account', count: 2 },
      ],
    });
    // Ids and dates only of a run kept: of a dropped one, not even its ids.
    expect(readFileSync(join(dir, SEED_RUNS_DROPPED_FILE), 'utf8')).not.toContain(fakeId('001', 1));
    expect(await nodeSeedRunsDropped(dir).find('op-other')).toBeUndefined();
  });

  it('makes the folder it keeps its file in when it is not there yet', async () => {
    const journal = join(dir, 'journal');

    await nodeSeedRunsDropped(journal).note(seed('op-big'));

    expect((await nodeSeedRunsDropped(journal).find('op-big'))?.runId).toBe('op-big');
  });

  it('names how a CSV import or a clone wrote the run', async () => {
    await nodeSeedRunsDropped(dir).note({ ...seed('op-csv'), origin: 'csv' });

    expect((await nodeSeedRunsDropped(dir).find('op-csv'))?.origin).toBe('csv');
  });

  it('keeps the latest dropped runs, the oldest going first past what it keeps', async () => {
    const index = new SeedRunsDropped(join(dir, SEED_RUNS_DROPPED_FILE), undefined, 2);

    await index.note(seed('op-1'));
    await index.note(seed('op-2'));
    await index.note(seed('op-3'));

    expect(await index.find('op-1')).toBeUndefined();
    expect((await index.find('op-2'))?.runId).toBe('op-2');
    expect((await index.find('op-3'))?.runId).toBe('op-3');
  });

  it('keeps every run dropped at once, each noted in turn', async () => {
    const index = nodeSeedRunsDropped(dir);

    void index.note(seed('op-1'));
    void index.note(seed('op-2'));

    expect((await index.find('op-1'))?.runId).toBe('op-1');
    expect((await index.find('op-2'))?.runId).toBe('op-2');
  });

  it('reads past a line it cannot read, and the latest line of a run noted twice', async () => {
    const file = join(dir, SEED_RUNS_DROPPED_FILE);
    writeFileSync(file, 'not json\n{"runId":"op-x"}\n');
    const index = nodeSeedRunsDropped(dir);

    await index.note(seed('op-1'), '2026-11-18T09:00:00.000Z');
    await index.note(seed('op-1'), '2026-11-18T10:00:00.000Z');

    expect((await index.find('op-1'))?.droppedAt).toBe('2026-11-18T10:00:00.000Z');
    expect(await index.find('op-x')).toBeUndefined();
  });

  it('says nothing of a run when its file cannot be written, and never throws', async () => {
    const index = new SeedRunsDropped(join(dir, 'missing', 'deeper', SEED_RUNS_DROPPED_FILE), {
      readFile: async () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
      appendFile: vi.fn(async () => {
        throw new Error('EACCES');
      }),
      writeFile: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });

    await expect(index.note(seed('op-1'))).resolves.toBeUndefined();
    expect(await index.find('op-1')).toBeUndefined();
  });
});

describe('droppedCleanupLine', () => {
  it('lists, without deleting, what was created in the org since the day the run started, by UTC, as many of each object as the run left', () => {
    expect(
      droppedCleanupLine(
        {
          runId: 'op-big',
          targetOrgId: 'org-target',
          // Late on the 2nd in Paris is the 2nd by UTC, the day --since reads.
          startedAt: '2026-11-02T23:40:00.000Z',
          droppedAt: '2026-11-18T09:00:00.000Z',
          left: [
            { objectApiName: 'Contact', count: 1200 },
            { objectApiName: 'Account', count: 300 },
          ],
        },
        'npx sandforge cleanup',
        'my-dev-org',
      ),
    ).toBe(
      'npx sandforge cleanup --target my-dev-org --since 2026-11-02 --objects Contact,Account ' +
        '--max 1200 --dry-run',
    );
  });

  it('leaves the objects to the cleanup’s own list when the run left none it knows', () => {
    expect(
      droppedCleanupLine(
        {
          runId: 'op-job',
          targetOrgId: 'org-target',
          startedAt: '2026-11-02T10:00:00.000Z',
          droppedAt: '2026-11-18T09:00:00.000Z',
          left: [],
        },
        'npx sandforge cleanup',
        'my-dev-org',
      ),
    ).toBe('npx sandforge cleanup --target my-dev-org --since 2026-11-02 --dry-run');
  });
});
