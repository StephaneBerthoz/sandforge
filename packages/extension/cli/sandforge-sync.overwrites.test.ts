import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { SyncConfig, SyncExecutionResult } from '@sandforge/shared';
import type { SyncOrchestratorDeps } from '../src/modules/sync/SyncOrchestrator.js';
import { MemoryRestoreOrg } from '../src/test/memoryRestoreOrg.js';
import { SYNC_RUNS_DIR, readRunFile } from '../src/modules/sync/SyncRunCreations.js';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
// What the target runs as a removal writes, as it reads it: nothing.
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({
    read: async () => ({ objectsRead: [], objects: [], unread: [] }),
  })),
}));

/** What each run handed the engine, and what the engine does with it. */
const engine = vi.hoisted(() => ({
  run: undefined as
    undefined | ((deps: SyncOrchestratorDeps, config: SyncConfig) => Promise<SyncExecutionResult>),
}));
vi.mock('../src/modules/sync/SyncOrchestrator.js', () => ({
  SyncOrchestrator: vi.fn(function (this: unknown, deps: SyncOrchestratorDeps) {
    return {
      execute: (config: SyncConfig) => {
        if (!engine.run) throw new Error('no engine run set');
        return engine.run(deps, config);
      },
    };
  }),
}));

import { makeConn } from './sfSession.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import {
  main,
  readRunSummary,
  restoredLines,
  runOfSummary,
  undeletedLines,
  writeCheckLines,
} from './sandforge-sync.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000002AAA';
const HELD = fakeId('001', 7);
const SOURCE_ID = fakeId('001', 90);

const argv = (...args: string[]): string[] => ['node', 'sandforge-sync.ts', ...args];
const journal = (): string => process.env['SANDFORGE_JOURNAL_DIR'] ?? '';
const runsDir = (): string => join(journal(), SYNC_RUNS_DIR);
const backupsDir = (): string => join(journal(), 'backups');

describe('what a run of sandforge-sync writes over, kept before it writes and given back', () => {
  let stdout: string;
  let stderr: string;
  let target: MemoryRestoreOrg;
  let upserted: Array<Record<string, unknown>>;

  beforeEach(() => {
    rmSync(runsDir(), { recursive: true, force: true });
    rmSync(backupsDir(), { recursive: true, force: true });
    target = new MemoryRestoreOrg();
    vi.mocked(removalOrg).mockReturnValue(target);
    upserted = [];
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async (soql: string) => {
        if (soql.startsWith('SELECT Id, IsSandbox')) {
          return { records: [{ Id: ORG_ID, IsSandbox: false }], totalSize: 1, done: true };
        }
        if (soql.startsWith('SELECT OrganizationType')) {
          return { records: [{ OrganizationType: 'Developer Edition' }], totalSize: 1, done: true };
        }
        if (soql.startsWith('SELECT Id, Ext__c, Name FROM Account WHERE Ext__c IN')) {
          return {
            records: soql.includes("'K-1'") ? [{ Id: HELD, Ext__c: 'K-1', Name: 'Before' }] : [],
            totalSize: 1,
            done: true,
          };
        }
        return { records: [{ Id: ORG_ID }], totalSize: 1, done: true };
      }),
      queryMore: vi.fn(),
      sobject: vi.fn(() => ({
        describe: async () => ({
          name: 'Account',
          fields: [
            { name: 'Name', type: 'string', createable: true, queryable: true },
            { name: 'Ext__c', type: 'string', createable: true, queryable: true },
          ],
        }),
        upsert: async (batch: Array<Record<string, unknown>>) => {
          upserted.push(...batch);
          return batch.map(() => ({ id: HELD, success: true, created: false }));
        },
      })),
    } as unknown as Connection);
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.run = undefined;
  });

  it('keeps the values an upsert writes over in the backup store before it writes, and --remove gives them back', async () => {
    engine.run = async (deps, config) => {
      // The engine's write of the account, through the command's own writer.
      const result = await deps.dataSync.sync(config.objects[0], [
        { Id: SOURCE_ID, Ext__c: 'K-1', Name: 'After' },
      ]);
      return {
        configId: config.id,
        operationId: 'op-1',
        status: 'success',
        objectResults: [result],
        totalProcessed: 1,
        totalSuccess: 1,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 10,
        timestamp: new Date().toISOString(),
      };
    };

    await main(argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account:Ext__c', '--json'));

    expect(upserted).toEqual([{ Ext__c: 'K-1', Name: 'After' }]);
    const [name] = readdirSync(runsDir()).filter((file) => file.endsWith('.ndjson'));
    const runId = name.replace(/\.ndjson$/, '');
    const backup = `sync-before-${runId}`;
    // The run's file names what it wrote over, and the backup: no value.
    const file = readFileSync(join(runsDir(), name), 'utf8');
    expect(file).not.toContain('Before');
    expect(readRunFile(file)?.overwritten).toEqual([
      { objectApiName: 'Account', backup, ids: [HELD] },
    ]);
    // The backup holds what the record held, listed as the DataOps command lines list one.
    expect(readFileSync(join(backupsDir(), 'backups', `${backup}__Account.ndjson`), 'utf8')).toBe(
      `${JSON.stringify({ Id: HELD, Name: 'Before' })}\n`,
    );
    const snapshots = JSON.parse(
      readFileSync(join(backupsDir(), 'snapshots.json'), 'utf8'),
    ) as Record<string, { value: string }>;
    expect(JSON.parse(snapshots[`backup:${backup}`].value)).toMatchObject({
      orgId: 'TGT',
      organizationId: ORG_ID,
      origin: 'sync',
      totalRecords: 1,
    });
    expect(JSON.parse(stdout).created).toMatchObject({
      overwritten: [{ objectApiName: 'Account', backup, ids: [HELD] }],
    });

    // The target as the run left it, then the removal.
    target.add('Account', { Id: HELD, Name: 'After', Ext__c: 'K-1' }, new Date().toISOString());
    stdout = '';
    await main(argv('--remove', runId, '--target', 'TGT', '--json'));

    expect(target.all('Account')).toEqual([expect.objectContaining({ Id: HELD, Name: 'Before' })]);
    expect(JSON.parse(stdout).result).toMatchObject({
      status: 'success',
      planned: 0,
      restored: [{ objectApiName: 'Account', planned: 1, restored: 1 }],
    });
    // Nothing more to give back.
    stdout = '';
    await main(argv('--remove', runId, '--target', 'TGT', '--json'));
    expect(stderr).toContain('what the run created was removed already');
  });

  it('says before it deletes anything that the values of a backup the retention took are no longer kept', async () => {
    engine.run = async (deps, config) => {
      const result = await deps.dataSync.sync(config.objects[0], [
        { Id: SOURCE_ID, Ext__c: 'K-1', Name: 'After' },
      ]);
      return {
        configId: config.id,
        operationId: 'op-1',
        status: 'success',
        objectResults: [result],
        totalProcessed: 1,
        totalSuccess: 1,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 10,
        timestamp: new Date().toISOString(),
      };
    };
    await main(argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account:Ext__c', '--json'));
    const [name] = readdirSync(runsDir()).filter((file) => file.endsWith('.ndjson'));
    const runId = name.replace(/\.ndjson$/, '');
    // A nightly sandforge-backup past the retention removed the run's backup, metadata first.
    const listing = join(backupsDir(), 'snapshots.json');
    const snapshots = JSON.parse(readFileSync(listing, 'utf8')) as Record<string, unknown>;
    delete snapshots[`backup:sync-before-${runId}`];
    writeFileSync(listing, JSON.stringify(snapshots));
    target.add('Account', { Id: HELD, Name: 'After', Ext__c: 'K-1' }, new Date().toISOString());
    stderr = '';

    await main(argv('--remove', runId, '--target', 'TGT', '--json')).catch(() => undefined);

    expect(stderr).not.toContain('Account: 1 to give back');
    expect(stderr).toContain(
      'values from before no longer kept (past sandforge.backup.maxAgeDays, or deleted): ' +
        '1 record(s) the run wrote over keep its values',
    );
  });

  it('keeps nothing for a run that only inserts', async () => {
    engine.run = async (_deps, config) => ({
      configId: config.id,
      operationId: 'op-1',
      status: 'success',
      objectResults: [],
      totalProcessed: 0,
      totalSuccess: 0,
      totalFailed: 0,
      totalSkipped: 0,
      duration: 1,
      timestamp: new Date().toISOString(),
    });

    await main(argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account', '--json'));

    expect(existsSync(join(backupsDir(), 'snapshots.json'))).toBe(false);
  });
});

describe('a summary printed with --json', () => {
  it('names what the run wrote over, which --remove gives back from it too', () => {
    const read = readRunSummary(
      JSON.stringify({
        tool: 'sandforge-sync',
        source: 'SRC',
        target: 'TGT',
        result: { status: 'success' },
        created: {
          runId: 'sandforge-sync-1',
          objects: [],
          overwritten: [{ objectApiName: 'Account', backup: 'sync-before-1', ids: [HELD] }],
        },
      }),
    );
    if ('refusal' in read) throw new Error(read.refusal);

    expect(runOfSummary(read.summary).overwritten).toEqual([
      { objectApiName: 'Account', backup: 'sync-before-1', ids: [HELD] },
    ]);
    // A backup the store could not name its files by is no summary of a run.
    expect(
      readRunSummary(
        JSON.stringify({
          tool: 'sandforge-sync',
          source: 'SRC',
          target: 'TGT',
          result: { status: 'success' },
          created: {
            runId: 'sandforge-sync-1',
            objects: [],
            overwritten: [{ objectApiName: 'Account', backup: '../x', ids: [HELD] }],
          },
        }),
      ),
    ).toHaveProperty('refusal');
  });
});

describe('what a run says before its first write of what it may write over', () => {
  it('counts the records an update or an upsert may write over, and says --remove puts them back', () => {
    expect(
      writeCheckLines(
        {
          objects: [{ objectApiName: 'Account', rows: 3 }],
          total: 3,
          alreadyCopied: 0,
          overwrites: 3,
          storage: { verdict: 'fits', estimateMB: 0.01, maxMB: 5, remainingMB: 5 },
          emails: [],
          verdict: 'writes',
        },
        'TRAP',
      ),
    ).toContain(
      '  of them, up to 3 written by an update or an upsert over records TRAP holds: their ' +
        'values are kept first, and --remove puts them back',
    );
  });
});

describe('restoredLines', () => {
  it('says per object what was given back, and what was left with why', () => {
    expect(
      restoredLines([
        {
          objectApiName: 'Account',
          planned: 3,
          restored: 1,
          keptChanged: 1,
          alreadyGone: 0,
          refused: 1,
          notKept: 0,
          reasons: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Name is locked'],
        },
      ]),
    ).toEqual([
      '  Account: 1 of 3 given back their values from before the run; 1 left as they are, ' +
        'changed since the run, 1 refused',
      '      FIELD_CUSTOM_VALIDATION_EXCEPTION: Name is locked',
    ]);
  });

  it('says what was given back but for the fields the org no longer takes', () => {
    expect(
      restoredLines([
        {
          objectApiName: 'Account',
          planned: 2,
          restored: 1,
          restoredWithout: 1,
          keptChanged: 0,
          alreadyGone: 0,
          refused: 0,
          notKept: 0,
          reasons: ['Account.Industry: the value from before is no longer taken'],
        },
      ])[0],
    ).toBe(
      '  Account: 1 of 2 given back their values from before the run; 1 given back but for ' +
        "fields the org no longer takes, which keep the run's values",
    );
  });
});

describe('undeletedLines', () => {
  it('says per object what the run deleted that was brought back, and what stays deleted', () => {
    expect(
      undeletedLines([
        {
          objectApiName: 'Contact',
          planned: 4,
          undeleted: 2,
          alreadyBack: 1,
          goneForGood: 1,
          refused: 0,
          reasons: [],
        },
      ]),
    ).toEqual([
      '  Contact: 2 of 4 the run deleted brought back from the recycle bin; 1 back in the org ' +
        'already, 1 no longer in the recycle bin, gone for good',
    ]);
  });
});
