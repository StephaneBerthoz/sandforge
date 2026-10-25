import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../sfSession.js', () => ({ loadOrg: vi.fn(), makeConn: vi.fn() }));
vi.mock('../sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('../sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));

import { EnvWorld, runInProcess } from './envWorld.js';

/*
 * The world the environment's tests run in: what the seed writes lands in the
 * memory org, and its own removal takes it back from there.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-world-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the world of the environment’s tests', () => {
  it('runs the seed in this process: its records land in the memory org, and its removal takes them back', async () => {
    const world = new EnvWorld();
    const template = join(dir, 'assets.json');
    writeFileSync(
      template,
      JSON.stringify({
        name: 'SFENV assets',
        strategy: 'faker',
        objects: [
          {
            objectApiName: 'Asset',
            recordCount: 2,
            fieldRules: [
              { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'SFENV asset' } },
            ],
            excludedFields: [],
            insertOrder: 0,
          },
        ],
      }),
    );
    const signal = new AbortController().signal;

    const run = await world.runner(
      'sandforge-seed',
      ['--target', 'TGT', '--template-file', template, '--seed', '1', '--json'],
      signal,
    );

    expect(run.code).toBe(0);
    expect(world.records('Asset').map((record) => record['Name'])).toEqual([
      'SFENV asset',
      'SFENV asset',
    ]);
    const summary = join(dir, 'run.json');
    writeFileSync(summary, run.stdout);
    const removed = await world.runner(
      'sandforge-seed',
      ['--remove', summary, '--target', 'TGT', '--json'],
      signal,
    );
    expect(removed.code).toBe(0);
    expect(world.records('Asset')).toEqual([]);
    expect(world.calls.map((call) => call.code)).toEqual([0, 0]);
    await expect(world.runner('sandforge-clone', [], signal)).rejects.toThrow(
      'The world runs sandforge-seed alone',
    );
  });

  it('gives back the exit code a script set or exited with, what it printed, and restores the process', async () => {
    const write = process.stdout.write;

    const exited = await runInProcess(async () => {
      process.stdout.write('out\n');
      process.stderr.write('err\n');
      process.exit(2);
    });
    const set = await runInProcess(async () => {
      process.exitCode = 3;
    });
    const thrown = await runInProcess(async () => {
      throw new Error('boom');
    });

    expect(exited).toEqual({ code: 2, stdout: 'out\n', stderr: 'err\n' });
    expect(set.code).toBe(3);
    expect(thrown).toEqual({ code: 1, stdout: '', stderr: 'boom\n' });
    expect(process.stdout.write).toBe(write);
    expect(process.exitCode).toBeUndefined();
  });
});
