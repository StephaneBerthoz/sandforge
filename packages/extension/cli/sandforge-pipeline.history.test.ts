import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/*
 * The runs the command line made of a pipeline on this machine: kept where
 * the editor's History tab lists them, as the launcher says it started them,
 * and listed by `history`; a dry run is none of them.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-history-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('sandforge pipeline history', () => {
  it('lists the runs the command line made, newest first, as started by the schedule, and no dry run', async () => {
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    const file = world.file({
      orgs: {
        'reg-uat': {
          alias: 'UAT',
          organizationId: WORLD_TARGET_ID,
          kind: 'sandbox',
          staging: false,
        },
      },
      steps: [step('s1', 'Wait', 'delay', { seconds: 0 })],
    });

    expect((await world.run(['run', '--file', file, '--triggered-by', 'schedule'])).code).toBe(0);
    expect((await world.run(['run', '--file', file, '--dry-run'])).code).toBe(0);
    const listed = await world.run(['history', '--file', file, '--json']);

    expect(listed.code).toBe(0);
    const answer = JSON.parse(listed.stdout) as {
      runs: Array<{ status: string; triggeredBy: string; ranFrom: string; stepCount: number }>;
    };
    expect(answer.runs).toEqual([
      expect.objectContaining({
        status: 'completed',
        triggeredBy: 'schedule',
        ranFrom: 'commandLine',
        stepCount: 1,
      }),
    ]);
    expect(listed.stderr).toContain(
      'Pipeline "Nightly reset": 1 run from the command line on this machine',
    );
  });
});
