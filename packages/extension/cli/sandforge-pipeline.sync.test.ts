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

import { main as syncMain } from './sandforge-sync.js';
import { runInProcess } from './testing/envWorld.js';
import { PipelineWorld, WORLD_TARGET_ID, step } from './testing/pipelineWorld.js';

/*
 * A pipeline's Sync step, run where VS Code is not: the Sync page's handler,
 * hosted by the command line, builds its engine through the orchestrator
 * factory the extension's services declare. Without it, the dry run and the
 * run both failed "this.deps.services.syncOrchestrator is not a function",
 * and no pipeline with a Sync ran from a terminal, a schedule or a CI.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-sync-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const UAT = { alias: 'UAT', organizationId: WORLD_TARGET_ID };
const SOURCE = { alias: 'SRC', organizationId: '00D000000000008SRC' };

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

/** A Sync configuration as the editor stores it: the accounts of SRC inserted into UAT. */
const ACCOUNTS_SYNC = {
  id: 'cfg-accounts',
  name: 'Accounts',
  description: '',
  sourceOrgId: 'reg-src',
  targetOrgId: 'reg-uat',
  direction: 'source_to_target',
  mode: 'full',
  objects: [
    {
      objectApiName: 'Account',
      operation: 'insert',
      batchSize: 200,
      fieldMappings: [],
      transformRules: [],
      excludedFields: [],
      addOnFields: [],
      insertOrder: 0,
    },
  ],
  conflictStrategy: 'source_wins',
  enableRollback: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

interface RunAnswer {
  status: string;
  dryRun?: boolean;
  steps: Array<{
    name: string;
    status: string;
    summary?: string;
    error?: string;
    output?: Record<string, unknown>;
    takeBack?: string;
  }>;
}

describe('sandforge pipeline, a Sync step', () => {
  function syncFile(world: PipelineWorld): string {
    return world.file({
      orgs: ORGS,
      steps: [step('s1', 'Push accounts', 'sync', { configId: ACCOUNTS_SYNC.id })],
      syncConfigs: { [ACCOUNTS_SYNC.id]: ACCOUNTS_SYNC },
    });
  }

  it('simulates in a dry run, writing nothing', async () => {
    const world = new PipelineWorld(dir, [UAT, SOURCE]);
    world.env.copyIn('Account', [{ Name: 'Held one' }, { Name: 'Held two' }]);
    const file = syncFile(world);

    const run = await world.run(['run', '--file', file, '--dry-run', '--json']);

    expect(run.stderr).not.toContain('is not a function');
    const answer = JSON.parse(run.stdout) as RunAnswer;
    expect(answer.steps[0]).toMatchObject({ name: 'Push accounts', status: 'completed' });
    expect(answer.steps[0]?.output?.['dryRun']).toBe(true);
    expect(answer.steps[0]?.summary).toBe(
      'Would sync "Accounts" into UAT: 2 to create, 0 to update, 0 to delete, 0 skipped and 0 ' +
        'refused of 2 read. Nothing was written.',
    );
    expect(run.code).toBe(0);
    expect(world.env.records('Account')).toHaveLength(2);
  });

  it('writes in a run, and prints the line that takes the run back', async () => {
    const world = new PipelineWorld(dir, [UAT, SOURCE]);
    world.env.copyIn('Account', [{ Name: 'Held one' }, { Name: 'Held two' }]);
    const file = syncFile(world);

    const run = await world.run(['run', '--file', file, '--json']);

    expect(run.stderr).not.toContain('is not a function');
    const answer = JSON.parse(run.stdout) as RunAnswer;
    expect(answer.steps[0]).toMatchObject({
      name: 'Push accounts',
      status: 'completed',
      summary: 'Synced "Accounts" into UAT: 2 records written, 0 failed and 0 skipped of 2 read.',
    });
    expect(run.code).toBe(0);
    expect(world.env.records('Account')).toHaveLength(4);
    expect(answer.steps[0]?.takeBack).toMatch(/--remove \S+ --target UAT --store /);
  });

  it('is taken back by the lines it prints after an Anonymize of what it wrote: the restore, then its removal, as printed', async () => {
    // Every org's connection is the memory org's: the two accounts read are
    // written beside themselves, and the masking writes over all four.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-20T02:00:00.000Z'));
    try {
      const world = new PipelineWorld(dir, [UAT, SOURCE]);
      const held = world.env.copyIn('Account', [{ Name: 'Held one' }, { Name: 'Held two' }]);
      // Each write over a record a few seconds on, as an org dates them.
      world.env.onUpdate = () => vi.setSystemTime(Date.now() + 5_000);
      const names = {
        id: 'mask-account-names',
        name: 'Account names',
        description: '',
        complianceFramework: 'custom',
        rules: [
          {
            fieldPattern: 'Account.Name',
            ruleType: 'mask',
            config: { maskKeepLast: 2 },
            description: '',
          },
        ],
        saved: true,
        createdAt: '2026-11-01T00:00:00.000Z',
      };
      const file = world.file({
        orgs: ORGS,
        steps: [
          step('s1', 'Push accounts', 'sync', { configId: ACCOUNTS_SYNC.id }),
          step('s2', 'Mask', 'anonymize', {
            orgId: 'reg-uat',
            templateId: names.id,
            object: 'Account',
          }),
        ],
        syncConfigs: { [ACCOUNTS_SYNC.id]: ACCOUNTS_SYNC },
        maskingTemplates: { [names.id]: names },
      });

      const run = await world.run(['run', '--file', file, '--json']);

      expect(run.code).toBe(0);
      const block = run.stderr.split('\n');
      const from = block.indexOf('To take this run back, in this order:');
      const [restoreLine = '', syncLine = ''] = block
        .slice(from + 1, from + 3)
        .map((line) => line.trim());
      expect(restoreLine).toMatch(/sandforge-dataops\.ts anonymize --org UAT --restore \S+$/);
      expect(syncLine).toMatch(
        /sandforge-sync\.ts --remove \S+ --target UAT --store \S+ --include-changed$/,
      );
      const argsOf = (line: string, from: string): string[] => {
        const words = line.split(' ');
        return words.slice(words.indexOf(from));
      };

      const restore = await world.env.runner(
        'sandforge-dataops',
        [...argsOf(restoreLine, 'anonymize'), '--yes'],
        new AbortController().signal,
      );
      expect(restore.code).toBe(0);
      const syncRemoval = (line: string) =>
        runInProcess(() => syncMain(['node', 'sandforge-sync.ts', ...argsOf(line, '--remove')]));
      // Without the flag, as the line was printed before: the copies kept.
      const kept = await syncRemoval(syncLine.replace(' --include-changed', ''));
      expect(kept.code).not.toBe(0);
      expect(world.env.records('Account')).toHaveLength(4);

      const removed = await syncRemoval(syncLine);

      expect(removed.code).toBe(0);
      const left = world.env.records('Account');
      expect(left.map((row) => row['Id']).sort()).toEqual([...held].sort());
      expect(left.map((row) => row['Name']).sort()).toEqual(['Held one', 'Held two']);
    } finally {
      vi.useRealTimers();
    }
  });
});
