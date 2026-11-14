import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rootsSha256 } from '../stages/QueryRoots.js';
import {
  ROOT_PLAN_MAX_AGE_MS,
  RootPlanError,
  dryRunRootPlanPathOf,
  keepRootPlan,
  lastDryRunRootPlan,
  openRootPlan,
  rootsDirOf,
  sweepRootPlans,
  type RootPlanToKeep,
} from './rootPlanStore.js';

const id = (n: number): string => `001S${String(n).padStart(11, '0')}AAA`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function storage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'root-plans-'));
  dirs.push(dir);
  return dir;
}

const NOW = new Date('2026-11-14T12:00:00.000Z');

function toKeep(over: Partial<RootPlanToKeep> = {}): RootPlanToKeep {
  return {
    sourceOrgId: 'src',
    fingerprint: 'a'.repeat(64),
    objectApiName: 'Account',
    query: { where: "Industry = 'Energy'", orderBy: 'CreatedDate DESC', limit: 50 },
    from: 'query',
    readAt: NOW.toISOString(),
    ids: [id(3), id(1), id(2), id(1)],
    ...over,
  };
}

describe('the roots a dry run keeps', () => {
  it('are kept sorted, each once, with the SHA-256 of their ids, and read back as kept', async () => {
    const file = dryRunRootPlanPathOf(storage(), 'a'.repeat(64));
    const kept = await keepRootPlan(file, toKeep());
    expect(kept.ids).toEqual([id(1), id(2), id(3)]);
    expect(kept.sha256).toBe(rootsSha256([id(1), id(2), id(3)]));
    expect(await openRootPlan(file)).toEqual(kept);
  });

  it('are their owner’s alone, in a folder of their own', async () => {
    const root = storage();
    const file = dryRunRootPlanPathOf(root, 'a'.repeat(64));
    await keepRootPlan(file, toKeep());
    if (process.platform === 'win32') return;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(rootsDirOf(root)).mode & 0o777).toBe(0o700);
  });

  it('are refused gone when not there, and changed when their ids no longer give their SHA-256', async () => {
    const file = join(storage(), 'roots.json');
    await expect(openRootPlan(file)).rejects.toMatchObject({ fault: 'gone' });
    await keepRootPlan(file, toKeep());
    const plan = JSON.parse(readFileSync(file, 'utf8')) as { ids: string[] };
    plan.ids.push(id(9));
    writeFileSync(file, JSON.stringify(plan));
    await expect(openRootPlan(file)).rejects.toBeInstanceOf(RootPlanError);
    await expect(openRootPlan(file)).rejects.toMatchObject({ fault: 'changed' });
    writeFileSync(file, '{ not json');
    await expect(openRootPlan(file)).rejects.toMatchObject({ fault: 'changed' });
  });

  it('refuse to keep what is not an id', async () => {
    await expect(
      keepRootPlan(join(storage(), 'roots.json'), toKeep({ ids: ["001' OR Name != '"] })),
    ).rejects.toThrow();
  });

  it('are taken up by the run after their dry run within a day, and said too old past it', async () => {
    const root = storage();
    const fingerprint = 'b'.repeat(64);
    expect(await lastDryRunRootPlan(root, fingerprint, NOW)).toBeUndefined();
    await keepRootPlan(dryRunRootPlanPathOf(root, fingerprint), toKeep({ fingerprint }));
    expect(await lastDryRunRootPlan(root, fingerprint, NOW)).toMatchObject({ fingerprint });
    const later = new Date(NOW.getTime() + ROOT_PLAN_MAX_AGE_MS);
    expect(await lastDryRunRootPlan(root, fingerprint, later)).toBe('tooOld');
  });

  it('name no file by what is no fingerprint', () => {
    expect(() => dryRunRootPlanPathOf(storage(), '../x')).toThrow(RootPlanError);
  });

  it('are swept a day after they were read, a half-written file by its date', async () => {
    const root = storage();
    await keepRootPlan(dryRunRootPlanPathOf(root, 'c'.repeat(64)), toKeep());
    await keepRootPlan(
      dryRunRootPlanPathOf(root, 'd'.repeat(64)),
      toKeep({ readAt: new Date(NOW.getTime() - ROOT_PLAN_MAX_AGE_MS).toISOString() }),
    );
    const half = join(rootsDirOf(root), 'x.json.1-ab.tmp');
    writeFileSync(half, '{');
    const old = new Date(NOW.getTime() - 2 * ROOT_PLAN_MAX_AGE_MS);
    utimesSync(half, old, old);
    expect(await sweepRootPlans(root, NOW)).toBe(2);
    expect(await lastDryRunRootPlan(root, 'c'.repeat(64), NOW)).toMatchObject({
      objectApiName: 'Account',
    });
    expect(await sweepRootPlans(storage(), NOW)).toBe(0);
  });
});
