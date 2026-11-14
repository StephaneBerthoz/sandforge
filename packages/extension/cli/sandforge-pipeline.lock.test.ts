import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', async (original) => ({
  ...(await original<typeof import('./sfSession.js')>()),
  loadOrg: vi.fn(),
  makeConn: vi.fn(),
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { PipelineWorld, WORLD_TARGET_ID, step } from './testing/pipelineWorld.js';
import { CompareHandler } from '../src/bridge/handlers/CompareHandler.js';
import type { LockSelf } from '../src/modules/checkpoint/linkedLock.js';
import {
  acquirePipelineRunLock,
  pipelineRunLockHolder,
} from '../src/modules/automation/PipelineRunLock.js';

/*
 * One run of a pipeline at a time on this machine: the command line holds
 * the lock a run in VS Code takes too, from before its store is read to its
 * end, and takes over one whose process has gone, saying so.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-lock-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A process of this machine that is running: the one that started this test. */
const RUNNING: LockSelf = {
  host: hostname(),
  pid: process.ppid,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
};

/** A process of this machine that has ended: no system gives out a process id this high. */
const ENDED: LockSelf = { ...RUNNING, pid: 2_000_000_000 };

const ORGS = {
  'reg-uat': {
    alias: 'UAT',
    organizationId: WORLD_TARGET_ID,
    kind: 'sandbox' as const,
    staging: false,
  },
  'reg-src': {
    alias: 'SRC',
    organizationId: '00D000000000008SRC',
    kind: 'sandbox' as const,
    staging: false,
  },
};

const COMPARE = step('s1', 'Diff', 'compare', {
  sourceOrgId: 'reg-src',
  targetOrgId: 'reg-uat',
  types: ['ApexClass'],
});

function world(): PipelineWorld {
  return new PipelineWorld(dir, [
    { alias: 'UAT', organizationId: WORLD_TARGET_ID },
    { alias: 'SRC', organizationId: '00D000000000008SRC' },
  ]);
}

const root = (): string => join(dir, 'journal', 'pipelines');

describe('the run lock of sandforge pipeline run', () => {
  it('refuses a run while another run of the pipeline holds it, saying who and since when', async () => {
    const pipelines = world();
    const compared = vi.spyOn(CompareHandler.prototype, 'compareOrgs');
    const held = acquirePipelineRunLock(
      root(),
      'pipe-nightly',
      { pipelineName: 'Nightly reset', ranFrom: 'editor', triggeredBy: 'schedule' },
      { self: RUNNING },
    );
    if (!('lock' in held)) throw new Error('the lock was not taken');

    const run = await pipelines.run([
      'run',
      '--file',
      pipelines.file({ orgs: ORGS, steps: [COMPARE] }),
    ]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      'Pipeline "Nightly reset" is already running on this machine: a run in VS Code started at',
    );
    expect(compared).not.toHaveBeenCalled();
    held.lock.release();
  });

  it('takes over the lock of a run whose process ended, and says so', async () => {
    const pipelines = world();
    vi.spyOn(CompareHandler.prototype, 'compareOrgs').mockResolvedValue({
      summary: { added: 0, removed: 0, modified: 0, unchanged: 1, total: 1 },
      items: [],
    } as never);
    acquirePipelineRunLock(
      root(),
      'pipe-nightly',
      { pipelineName: 'Nightly reset', ranFrom: 'commandLine', triggeredBy: 'schedule' },
      { self: ENDED },
    );

    const run = await pipelines.run([
      'run',
      '--file',
      pipelines.file({ orgs: ORGS, steps: [COMPARE] }),
    ]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('whose process has ended: taken over.');
    expect(pipelineRunLockHolder(root(), 'pipe-nightly')).toBeUndefined();
  });

  it('holds the lock as the command line’s while the run goes, as VS Code reads it, and lets it go at the end', async () => {
    const pipelines = world();
    let during: unknown;
    vi.spyOn(CompareHandler.prototype, 'compareOrgs').mockImplementation(async () => {
      during = pipelineRunLockHolder(root(), 'pipe-nightly');
      return {
        summary: { added: 0, removed: 0, modified: 0, unchanged: 1, total: 1 },
        items: [],
      } as never;
    });

    const run = await pipelines.run([
      'run',
      '--file',
      pipelines.file({ orgs: ORGS, steps: [COMPARE] }),
    ]);

    expect(run.code).toBe(0);
    expect(during).toMatchObject({ ranFrom: 'commandLine', pid: process.pid });
    expect(pipelineRunLockHolder(root(), 'pipe-nightly')).toBeUndefined();
  });
});
