import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../sfSession.js', async (original) => ({
  ...(await original<typeof import('../sfSession.js')>()),
  loadOrg: vi.fn(),
  makeConn: vi.fn(),
}));
vi.mock('../sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('../sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
vi.mock('../../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { runnerWithCheckpoints } from './envCheckpointWorld.js';
import { EnvWorld } from './envWorld.js';

/*
 * The checkpoint script run whole on the world's own memory org: a take of
 * what the world holds, a preview that names who changed it, a rewind that
 * gives records their values back in the org itself.
 */

const COLLEAGUE = '005000000000003AAA';
const T0 = Date.parse('2026-10-25T09:00:00.000Z');

let dir: string;
let store: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-checkpoint-world-'));
  store = join(dir, 'checkpoints');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A world of two accounts, and its runner, the checkpoint script among its scripts. */
function worldOf(options: { modifyAllData?: boolean } = {}) {
  const world = new EnvWorld({ sandbox: false, edition: 'Developer Edition' });
  vi.setSystemTime(T0 - 3_600_000);
  world.org.add('Account', { Id: '001000000000001AAA', Name: 'Northwind' });
  world.org.add('Account', { Id: '001000000000002AAA', Name: 'Contoso' });
  vi.setSystemTime(T0);
  const runner = runnerWithCheckpoints(world, {
    locksDir: join(dir, 'locks'),
    users: { [COLLEAGUE]: 'Colleague' },
    ...(options.modifyAllData !== undefined
      ? { permissions: { modifyAllData: options.modifyAllData } }
      : {}),
  });
  const checkpoint = async (...args: string[]) => {
    const run = await runner(
      'sandforge-checkpoint',
      [...args, '--org', 'DEV', '--store', store, '--json'],
      new AbortController().signal,
    );
    return {
      ...run,
      answer:
        run.stdout.trim() === '' ? undefined : (JSON.parse(run.stdout) as Record<string, unknown>),
    };
  };
  return { world, runner, checkpoint };
}

describe('the checkpoint script on the world’s org', () => {
  it('takes a checkpoint of what the world’s org holds, with the stamps of each record', async () => {
    const { world, checkpoint } = worldOf();

    const taken = await checkpoint('take', '--name', 'baseline', '--keep-days', '0');

    expect(taken.code, taken.stderr).toBe(0);
    const kept = taken.answer?.['checkpoint'] as {
      objects: Array<{ objectApiName: string; records: number }>;
    };
    expect(kept.objects.find((o) => o.objectApiName === 'Account')?.records).toBe(2);
    expect(world.calls.map((call) => [call.script, call.args[0], call.code])).toEqual([
      ['sandforge-checkpoint', 'take', 0],
    ]);
  });

  it('previews what changed since, naming who changed it, and rewinds the org itself to it', async () => {
    const { world, checkpoint } = worldOf();
    const taken = await checkpoint('take', '--name', 'baseline', '--keep-days', '0');
    const id = (taken.answer?.['checkpoint'] as { checkpointId: string }).checkpointId;
    vi.setSystemTime(T0 + 60_000);
    world.org.edit('Account', '001000000000001AAA', { Name: 'Renamed' }, COLLEAGUE);

    const preview = await checkpoint('preview', '--checkpoint', id);
    const rewind = await checkpoint('rewind', '--checkpoint', id, '--yes');

    expect(preview.code).toBe(0);
    expect(preview.answer).toMatchObject({ toGiveBack: 1, differs: true });
    expect(preview.stderr).toContain('last changed by: Colleague 1');
    expect(rewind.code, rewind.stderr).toBe(0);
    expect(
      world
        .records('Account')
        .map((row) => row['Name'])
        .sort(),
    ).toEqual(['Contoso', 'Northwind']);
  });

  it('answers as the user the test gives: without Modify All Data, a take is refused by the guard', async () => {
    const { checkpoint } = worldOf({ modifyAllData: false });

    const estimated = await checkpoint('take', '--estimate');

    expect(estimated.code).toBe(1);
    expect(estimated.answer).toMatchObject({ refusal: { code: 'PERMISSIONS' } });
  });

  it('runs every other script as the world runs it', async () => {
    const { runner } = worldOf();

    await expect(
      runner('sandforge-sync', ['--source', 'SRC'], new AbortController().signal),
    ).rejects.toThrow('The world runs sandforge-seed');
  });
});
