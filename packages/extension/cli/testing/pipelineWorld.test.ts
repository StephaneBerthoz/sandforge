import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

import { readPipelineFile } from '@sandforge/shared';
import { AuthProvider } from '../../src/core/connection/AuthProvider.js';
import { loadOrg } from '../sfSession.js';
import { PipelineWorld, WORLD_TARGET_ID, step } from './pipelineWorld.js';

/*
 * The world of the pipeline command's tests: each alias answers with an
 * Organization record of its own, the file is written as an export writes
 * one, and the command runs in this process.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-world-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the world of the pipeline command’s tests', () => {
  it('answers each alias with its own session and Organization record, and an unknown alias as sf does', async () => {
    new PipelineWorld(dir, [
      { alias: 'UAT', organizationId: WORLD_TARGET_ID, scratch: true },
      {
        alias: 'PROD',
        organizationId: '00D000000000002AAA',
        sandbox: false,
        edition: 'Enterprise Edition',
      },
    ]);

    const uat = await loadOrg('UAT');
    const prod = await loadOrg('PROD');
    const identity = await new AuthProvider().validateConnection(
      prod.accessToken,
      prod.instanceUrl,
    );

    expect(uat).toMatchObject({ alias: 'UAT', scratch: true });
    expect(identity).toMatchObject({
      orgId: '00D000000000002AAA',
      isSandbox: false,
      orgType: 'Enterprise Edition',
    });
    await expect(loadOrg('DEV')).rejects.toThrow('sf does not know DEV');
  });

  it('writes a pipeline file that reads, and runs the command, its exit code and output kept', async () => {
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

    expect(readPipelineFile(readFileSync(file, 'utf8'))).toMatchObject({
      ok: true,
      digestMatches: true,
    });
    const run = await world.run(['plan', '--file', file]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      'Pipeline "Nightly reset" (1 step), exported from SandForge 1.81.0',
    );
  });
});
