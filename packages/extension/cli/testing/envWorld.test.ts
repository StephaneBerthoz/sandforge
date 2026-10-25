import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
vi.mock('../../src/modules/forge/RunVerifier.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/forge/RunVerifier.js')>()),
  verifiedOrg: vi.fn(),
}));
vi.mock('../../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { EnvWorld, runInProcess } from './envWorld.js';
import { freezeDataset } from './frozenDataset.js';

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
      'The world runs sandforge-seed, sandforge-frozen alone, not sandforge-clone',
    );
  });

  it('runs the clone in this process, from the source org to the target: its records land in the target, its preview and its verification read them, and its removal takes them back', async () => {
    const world = new EnvWorld({ source: { alias: 'SRC' } });
    world.seedSource('Account', [{ Name: 'SFENV clone' }, { Name: 'SFENV other' }]);
    const [account] = world.source?.all('Account') ?? [];
    world.seedSource('Contact', [{ LastName: 'SFENV clone', AccountId: account?.Id }]);
    const summary = join(dir, 'clone-summary.json');
    const signal = new AbortController().signal;
    const tables = [
      '--object',
      'Account',
      '--where',
      "Name = 'SFENV clone'",
      '--object',
      'Contact',
    ];

    const dry = await world.runner(
      'sandforge-clone',
      ['--source', 'SRC', '--target', 'TGT', ...tables, '--skip-preflight', '--dry-run', '--json'],
      signal,
    );
    const run = await world.runner(
      'sandforge-clone',
      [
        '--source',
        'SRC',
        '--target',
        'TGT',
        ...tables,
        '--skip-preflight',
        '--summary',
        summary,
        '--json',
      ],
      signal,
    );

    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ writePlan: { totalRows: 2 } });
    expect(run.code, run.stderr).toBe(0);
    expect(world.records('Account').map((record) => record['Name'])).toEqual(['SFENV clone']);
    const [cloned] = world.records('Account');
    expect(world.records('Contact')).toEqual([
      expect.objectContaining({ LastName: 'SFENV clone', AccountId: cloned?.['Id'] }),
    ]);
    const preview = await world.runner(
      'sandforge-clone',
      ['--remove', summary, '--target', 'TGT', '--preview', '--json'],
      signal,
    );
    expect(JSON.parse(preview.stdout)).toMatchObject({ preview: { planned: 2 } });
    const verified = await world.runner(
      'sandforge-clone',
      ['--verify', summary, '--target', 'TGT', '--source', 'SRC', '--json'],
      signal,
    );
    expect(JSON.parse(verified.stdout)).toMatchObject({ result: { verdict: 'verified' } });
    const removed = await world.runner(
      'sandforge-clone',
      ['--remove', summary, '--target', 'TGT', '--json'],
      signal,
    );
    expect(removed.code, removed.stderr).toBe(0);
    expect(world.records('Account')).toEqual([]);
    expect(world.records('Contact')).toEqual([]);
    expect(world.source?.all('Account')).toHaveLength(2);
  });

  it('runs a Frozen load in this process, through the panel’s handler: its records land in the memory org, verified, and its removal takes them back', async () => {
    const world = new EnvWorld();
    const datasetDir = await freezeDataset(join(dir, 'dataset'), {
      accounts: 2,
      perAccount: 1,
      mark: 'world',
    });
    const config = join(dir, 'frozen.json');
    writeFileSync(
      config,
      JSON.stringify({
        rootObject: 'Account',
        axes: [],
        edgeCases: [],
        sasDir: join(dir, 'sas'),
        datasetDir,
      }),
    );
    const signal = new AbortController().signal;
    const frozen = (args: string[]) =>
      world.runner(
        'sandforge-frozen',
        [...args, '--config', config, '--target', 'TGT', '--json'],
        signal,
      );

    const loaded = await frozen(['load', '--yes']);

    expect(loaded.code, loaded.stderr).toBe(0);
    expect(world.records('Account').map((row) => row['Name'])).toEqual([
      'SFENV world 1',
      'SFENV world 2',
    ]);
    const accounts = new Set(world.records('Account').map((row) => row['Id']));
    for (const contact of world.records('Contact')) {
      expect(accounts.has(contact['AccountId'])).toBe(true);
    }
    expect(JSON.parse(loaded.stdout)).toMatchObject({ verdict: { status: 'PASSED' } });
    const removed = await frozen(['remove', '--yes']);
    expect(removed.code, removed.stderr).toBe(0);
    expect(world.records('Account')).toEqual([]);
    expect(world.records('Contact')).toEqual([]);
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
