import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SEED_RUNS_DIR,
  SeedRunCreations,
  nodeSeedRunCreations,
  seedRunKept,
  type SeedRunEnded,
} from './SeedRunCreations';
import { nodeSyncRunCreations, syncRemovalPlan } from '../sync/SyncRunCreations';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

function run(runId: string, extra: Partial<SeedRunEnded> = {}): SeedRunEnded {
  return {
    runId,
    targetOrgId: 'org-target',
    startedAt: '2026-10-17T10:00:00.000Z',
    finishedAt: '2026-10-17T10:01:00.000Z',
    status: 'success',
    objectResults: [
      { objectApiName: 'Account', createdIds: [fakeId('001', 1), fakeId('001', 2)] },
      { objectApiName: 'Contact', createdIds: [fakeId('003', 1)] },
      { objectApiName: 'Opportunity', createdIds: [] },
    ],
    ...extra,
  };
}

describe('seedRunKept', () => {
  it('reads a run as the removal reads one: what it created per object, the objects it wrote none of left out', () => {
    const kept = seedRunKept(run('op-1'));

    expect(kept).toMatchObject({
      runId: 'op-1',
      targetOrgId: 'org-target',
      startedAt: '2026-10-17T10:00:00.000Z',
      end: { at: '2026-10-17T10:01:00.000Z', status: 'success' },
      lastWrittenAt: '2026-10-17T10:01:00.000Z',
      created: [
        { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
        { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
      ],
    });
    // The children first, the last record written first.
    expect(syncRemovalPlan(kept).map((o) => o.objectApiName)).toEqual(['Contact', 'Account']);
  });
});

describe('SeedRunCreations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-runs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps what a run created on disk, where a store made after a reload reads it whole', async () => {
    await nodeSeedRunCreations(dir).record(run('op-1'));

    // A new store over the same directory: the window was reloaded.
    const kept = await nodeSeedRunCreations(dir).get('op-1');

    expect(kept).toMatchObject({
      runId: 'op-1',
      targetOrgId: 'org-target',
      startedAt: '2026-10-17T10:00:00.000Z',
      end: { status: 'success' },
      created: [
        { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
        { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
      ],
    });
    expect(syncRemovalPlan(kept!).map((o) => o.objectApiName)).toEqual(['Contact', 'Account']);
    // Beside a Sync run's, never among them.
    expect(readdirSync(join(dir, SEED_RUNS_DIR))).toEqual(['op-1.ndjson']);
    expect(await nodeSyncRunCreations(dir).list()).toEqual([]);
  });

  it('writes each insert down as it is noted, so a run that never ended is read back with what it wrote', async () => {
    const recorder = nodeSeedRunCreations(dir).recorder({
      runId: 'op-cut',
      targetOrgId: 'org-target',
      startedAt: '2026-10-17T10:00:00.000Z',
    });
    recorder.note('Account', [fakeId('001', 1), fakeId('001', 2)]);
    recorder.note('Contact', [fakeId('003', 1)]);

    // The window closed: no end. A store made after the reload reads the file.
    await vi.waitFor(async () =>
      expect((await nodeSeedRunCreations(dir).get('op-cut'))?.created).toHaveLength(2),
    );
    const kept = await nodeSeedRunCreations(dir).get('op-cut');
    expect(kept?.end).toBeUndefined();
    expect(kept?.lastWrittenAt).toBeDefined();
    expect(kept?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
    ]);
    expect(syncRemovalPlan(kept!).map((o) => o.objectApiName)).toEqual(['Contact', 'Account']);
  });

  it('ends a run it wrote as it went with what its result holds that no insert noted, once', async () => {
    const runs = nodeSeedRunCreations(dir);
    const recorder = runs.recorder({ runId: 'op-1', targetOrgId: 'org-target' });
    recorder.note('Account', [fakeId('001', 1)]);

    await recorder.end(run('op-1'));

    const kept = await runs.get('op-1');
    expect(kept?.end).toMatchObject({ status: 'success', at: '2026-10-17T10:01:00.000Z' });
    expect(kept?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
    ]);
  });

  it('keeps every id of an object past what one line of the file holds', async () => {
    const createdIds = Array.from({ length: 60_000 }, (_, i) => fakeId('003', i + 1));
    await nodeSeedRunCreations(dir).record(
      run('op-big', { objectResults: [{ objectApiName: 'Contact', createdIds }] }),
    );

    const kept = await nodeSeedRunCreations(dir).get('op-big');
    expect(kept?.created).toEqual([{ objectApiName: 'Contact', ids: createdIds }]);
  });

  it('keeps nothing of a run that created nothing', async () => {
    const runs = nodeSeedRunCreations(dir);
    await runs.record(
      run('op-empty', { objectResults: [{ objectApiName: 'Account', createdIds: [] }] }),
    );

    expect(await runs.get('op-empty')).toBeUndefined();
    expect(await runs.list()).toEqual([]);
  });

  it('keeps the latest runs, the oldest removed with nothing left going first past the bound', async () => {
    const runs = new SeedRunCreations(nodeSyncRunCreations(dir, SEED_RUNS_DIR), 2);
    const at = (minute: number) => `2026-10-17T10:0${minute}:00.000Z`;
    await runs.record(run('op-1', { startedAt: at(1) }));
    await runs.record(run('op-2', { startedAt: at(2) }));
    // The newer of the two removed whole: it goes before the older one.
    await runs.updateRemoval('op-2', () => ({
      undo: { removedAt: at(5), deleted: 3, alreadyGone: 0, kept: 0, refused: 0 },
    }));
    await runs.record(run('op-3', { startedAt: at(3) }));

    expect((await runs.list()).map((r) => r.runId)).toEqual(['op-3', 'op-1']);

    await runs.record(run('op-4', { startedAt: at(4) }));
    expect((await runs.list()).map((r) => r.runId)).toEqual(['op-4', 'op-3']);
  });

  it('keeps what a removal did on the run, for the next removal to read after a reload', async () => {
    const runs = nodeSeedRunCreations(dir);
    await runs.record(run('op-1'));

    await runs.updateRemoval('op-1', (state) => ({
      ...state,
      removalLeft: [fakeId('001', 2)],
    }));

    const kept = await nodeSeedRunCreations(dir).get('op-1');
    expect(kept?.removal).toEqual({ removalLeft: [fakeId('001', 2)] });
    expect(syncRemovalPlan(kept!)).toEqual([{ objectApiName: 'Account', ids: [fakeId('001', 2)] }]);
    await runs.updateRemoval('never-ran', (state) => state);
    expect(await runs.get('never-ran')).toBeUndefined();
  });
});
