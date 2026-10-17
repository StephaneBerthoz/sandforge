import { describe, it, expect } from 'vitest';
import { SeedRunCreations, seedRunKept, type SeedRunEnded } from './SeedRunCreations';
import { syncRemovalPlan } from '../sync/SyncRunCreations';

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
  it('keeps what a run created, and nothing of a run that created nothing', () => {
    const runs = new SeedRunCreations();
    runs.record(run('op-1'));
    runs.record(run('op-empty', { objectResults: [{ objectApiName: 'Account', createdIds: [] }] }));

    expect(runs.get('op-1')?.created).toHaveLength(2);
    expect(runs.get('op-empty')).toBeUndefined();
  });

  it('keeps the latest runs, the oldest going first past its bound', () => {
    const runs = new SeedRunCreations(2);
    runs.record(run('op-1'));
    runs.record(run('op-2'));
    runs.record(run('op-3'));

    expect(runs.get('op-1')).toBeUndefined();
    expect(runs.get('op-2')).toBeDefined();
    expect(runs.get('op-3')).toBeDefined();
  });

  it('keeps what a removal did on the run, for the next removal to read', async () => {
    const runs = new SeedRunCreations();
    runs.record(run('op-1'));

    await runs.updateRemoval('op-1', (state) => ({
      ...state,
      removalLeft: [fakeId('001', 2)],
    }));

    const kept = runs.get('op-1');
    expect(kept?.removal).toEqual({ removalLeft: [fakeId('001', 2)] });
    await runs.updateRemoval('never-ran', (state) => state);
    expect(runs.get('never-ran')).toBeUndefined();
  });
});
