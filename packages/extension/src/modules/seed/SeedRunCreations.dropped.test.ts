import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncRunKept } from '../sync/SyncRunCreations';

// The bound on the runs' files drops a run past 64 MB of them: what it tells
// is handed on here as the store makes it.
const told = vi.hoisted(() => ({ onDropped: [] as Array<(run: SyncRunKept) => void> }));
vi.mock('../sync/SyncRunCreations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync/SyncRunCreations.js')>();
  return {
    ...actual,
    nodeSyncRunCreations: (
      storagePath: string,
      runsDir?: string,
      onDropped?: (run: SyncRunKept) => void,
    ) => {
      if (onDropped) told.onDropped.push(onDropped);
      return actual.nodeSyncRunCreations(storagePath, runsDir, onDropped);
    },
  };
});

import { nodeSeedRunCreations, seedRunKept } from './SeedRunCreations';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

describe('a Seed run the bound on the runs’ files dropped, its records still in its org', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-runs-dropped-'));
    told.onDropped.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is kept in the index the store reads it back from, and told to the caller too', async () => {
    const callerTold: string[] = [];
    const store = nodeSeedRunCreations(dir, (run) => callerTold.push(run.runId));
    const run = seedRunKept({
      runId: 'op-big',
      targetOrgId: 'org-target',
      startedAt: '2026-11-02T10:00:00.000Z',
      finishedAt: '2026-11-02T10:05:00.000Z',
      status: 'success',
      objectResults: [{ objectApiName: 'Contact', createdIds: [fakeId('003', 1)] }],
    });

    for (const drop of told.onDropped) drop(run);

    expect(callerTold).toEqual(['op-big']);
    expect(await store.dropped('op-big')).toMatchObject({
      runId: 'op-big',
      targetOrgId: 'org-target',
      left: [{ objectApiName: 'Contact', count: 1 }],
    });
    // A store made after a reload reads it too.
    expect((await nodeSeedRunCreations(dir).dropped('op-big'))?.runId).toBe('op-big');
    expect(await store.dropped('op-other')).toBeUndefined();
  });
});
