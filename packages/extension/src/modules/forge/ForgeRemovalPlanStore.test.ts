import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { ForgeRemovalPlan } from '@sandforge/shared';

import {
  ForgeRemovalPlanStore,
  REMOVAL_PLANS_FILE,
  REMOVAL_PLANS_MAX_BYTES,
} from './ForgeRemovalPlanStore.js';

const STORAGE = '/storage';
const FILE = path.join(STORAGE, REMOVAL_PLANS_FILE);

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** A disk in memory, with the writes it was asked for. */
function memoryDisk() {
  const files = new Map<string, string>();
  const writes: string[] = [];
  return {
    files,
    writes,
    deps: {
      storagePath: STORAGE,
      readFile: async (filePath: string) => {
        const content = files.get(filePath);
        if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
        return content;
      },
      writeFile: async (filePath: string, content: string) => {
        writes.push(filePath);
        files.set(filePath, content);
      },
      rename: async (from: string, to: string) => {
        const content = files.get(from);
        if (content === undefined) throw new Error(`ENOENT: ${from}`);
        files.delete(from);
        files.set(to, content);
      },
      mkdir: async () => undefined,
    },
  };
}

/** A run's plan: `count` accounts it created. */
function plan(forgeId: string, count = 2, overrides: Partial<ForgeRemovalPlan> = {}) {
  return {
    forgeId,
    targetOrgId: 'org-target',
    timestamp: '2026-09-20T10:05:00.000Z',
    duration: 1_000,
    status: 'success',
    objects: [
      { objectApiName: 'Account', ids: Array.from({ length: count }, (_, n) => id('001', n + 1)) },
    ],
    linked: 0,
    ...overrides,
  } satisfies ForgeRemovalPlan;
}

describe('ForgeRemovalPlanStore', () => {
  it('keeps plans newest first, one per run, in a file of the extension storage', async () => {
    const disk = memoryDisk();
    const store = new ForgeRemovalPlanStore(disk.deps);

    await store.put(plan('forge-1'));
    await store.put(plan('forge-2'));
    await store.put(plan('forge-1', 3));

    expect((await store.list()).map((p) => [p.forgeId, p.objects[0].ids.length])).toEqual([
      ['forge-1', 3],
      ['forge-2', 2],
    ]);
    expect(disk.files.has(FILE)).toBe(true);
  });

  it('writes through a file beside it renamed over it, so a stopped write leaves the last whole file', async () => {
    const disk = memoryDisk();
    const store = new ForgeRemovalPlanStore(disk.deps);

    await store.put(plan('forge-1'));

    expect(disk.writes).toEqual([`${FILE}.${process.pid}.tmp`]);
    expect([...disk.files.keys()]).toEqual([FILE]);
  });

  it('drops the oldest plans past the bound on bytes, and keeps the newest whatever its size', async () => {
    const disk = memoryDisk();
    const one = JSON.stringify({ version: 1, plans: [plan('forge-0', 50)] }).length;
    const store = new ForgeRemovalPlanStore({ ...disk.deps, maxBytes: one * 2 + 50 });

    for (const n of [1, 2, 3]) await store.put(plan(`forge-${n}`, 50));
    expect((await store.list()).map((p) => p.forgeId)).toEqual(['forge-3', 'forge-2']);

    await store.put(plan('forge-big', 500));
    expect((await store.list()).map((p) => p.forgeId)).toEqual(['forge-big']);
    expect(REMOVAL_PLANS_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  it('changes a plan where it stands, and drops one the change returns nothing for', async () => {
    const disk = memoryDisk();
    const store = new ForgeRemovalPlanStore(disk.deps);
    await store.put(plan('forge-1'));
    await store.put(plan('forge-2'));

    await store.update('forge-1', (p) => ({ ...p, removalLeft: [id('001', 2)] }));
    await store.update('forge-2', () => undefined);
    await store.update('forge-unknown', () => plan('forge-unknown'));

    expect(await store.list()).toEqual([{ ...plan('forge-1'), removalLeft: [id('001', 2)] }]);
  });

  it('keeps a plan put if absent in the order of the runs, and never over one kept already', async () => {
    const disk = memoryDisk();
    const store = new ForgeRemovalPlanStore(disk.deps);
    await store.put(plan('forge-new', 2, { timestamp: '2026-09-22T10:00:00.000Z' }));
    await store.put(plan('forge-kept', 2, { removalLeft: [id('001', 1)] }));

    await store.putIfAbsent(plan('forge-old', 2, { timestamp: '2026-09-01T10:00:00.000Z' }));
    await store.putIfAbsent(plan('forge-kept', 2));

    const plans = await store.list();
    expect(plans.map((p) => p.forgeId)).toEqual(['forge-new', 'forge-kept', 'forge-old']);
    expect(plans[1].removalLeft).toEqual([id('001', 1)]);
  });

  it('runs one change at a time, so two at once lose neither', async () => {
    const disk = memoryDisk();
    const store = new ForgeRemovalPlanStore(disk.deps);

    await Promise.all([store.put(plan('forge-1')), store.put(plan('forge-2'))]);

    expect((await store.list()).map((p) => p.forgeId).sort()).toEqual(['forge-1', 'forge-2']);
  });

  it('reads no plan from a file that is missing or not one, and leaves out a plan that is not what it should be', async () => {
    const disk = memoryDisk();
    const store = new ForgeRemovalPlanStore(disk.deps);
    expect(await store.list()).toEqual([]);

    disk.files.set(FILE, 'not json');
    expect(await store.list()).toEqual([]);

    disk.files.set(
      FILE,
      JSON.stringify({
        version: 1,
        plans: [
          plan('forge-good'),
          {
            ...plan('forge-bad-id'),
            objects: [{ objectApiName: 'Account', ids: ["x' OR Id != '"] }],
          },
          { ...plan('forge-bad-name'), objects: [{ objectApiName: 'Account; DELETE', ids: [] }] },
          'not a plan',
        ],
      }),
    );
    expect((await store.list()).map((p) => p.forgeId)).toEqual(['forge-good']);
    expect(await store.get('forge-good')).toEqual(plan('forge-good'));
    expect(await store.get('forge-bad-id')).toBeUndefined();
  });
});
