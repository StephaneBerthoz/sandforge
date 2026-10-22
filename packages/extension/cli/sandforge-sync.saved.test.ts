import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { SyncConfig, SyncExecutionResult } from '@sandforge/shared';
import type { SyncOrchestratorDeps } from '../src/modules/sync/SyncOrchestrator.js';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));

/** What each run handed the engine, and what the engine does with it. */
const engine = vi.hoisted(() => ({
  deps: [] as SyncOrchestratorDeps[],
  run: undefined as
    undefined | ((deps: SyncOrchestratorDeps, config: SyncConfig) => Promise<SyncExecutionResult>),
}));
vi.mock('../src/modules/sync/SyncOrchestrator.js', () => ({
  SyncOrchestrator: vi.fn(function (this: unknown, deps: SyncOrchestratorDeps) {
    engine.deps.push(deps);
    return {
      execute: (config: SyncConfig) => {
        if (!engine.run) throw new Error('no engine run set');
        return engine.run(deps, config);
      },
    };
  }),
}));

import { makeConn } from './sfSession.js';
import { main, savedConfigStore } from './sandforge-sync.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const argv = (...args: string[]): string[] => ['node', 'sandforge-sync.ts', ...args];

/** A delta configuration of accounts that copies their files, as the panel saves one. */
const SAVED = {
  id: 'cfg-accounts',
  name: 'Accounts',
  description: '',
  sourceOrgId: '00D000000000001AAA',
  targetOrgId: '00D000000000002AAA',
  direction: 'source_to_target',
  mode: 'delta',
  objects: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      externalIdField: 'Ext_Id__c',
      fieldMappings: [],
      transformRules: [],
      excludedFields: [],
      addOnFields: [],
      insertOrder: 0,
    },
  ],
  conflictStrategy: 'source_wins',
  enableRollback: false,
  files: { maxFileSizeMB: 10, maxRunMB: 100 },
};

/** A run that wrote one account, as the engine answers it. */
function answered(config: SyncConfig): SyncExecutionResult {
  return {
    configId: config.id,
    operationId: 'op-1',
    status: 'success',
    objectResults: [],
    totalProcessed: 1,
    totalSuccess: 1,
    totalFailed: 0,
    totalSkipped: 0,
    duration: 10,
    timestamp: new Date().toISOString(),
  };
}

describe('sandforge-sync --config-file', () => {
  let dir: string;
  let file: string;
  let store: string;
  let stdout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-saved-'));
    file = join(dir, 'accounts.json');
    store = join(dir, 'state');
    writeFileSync(file, JSON.stringify(SAVED));
    engine.deps = [];
    vi.mocked(makeConn).mockClear();
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async () => ({
        records: [{ Id: '00D000000000002AAA', IsSandbox: true }],
        totalSize: 1,
      })),
      queryMore: vi.fn(),
    } as unknown as Connection);
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (): Promise<void> =>
    main(
      argv('--config-file', file, '--store', store, '--source', 'SRC', '--target', 'TGT', '--json'),
    );

  it('keeps the watermarks and copied files of a run in the store, where the next run reads them', async () => {
    const watermark = {
      sourceOrgId: 'SRC',
      targetOrgId: 'TGT',
      objectApiName: 'Account',
      watermark: '2026-10-14T08:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      recordedAt: '2026-10-14T08:01:00.000Z',
    };
    const file1 = {
      sourceOrgId: 'SRC',
      targetOrgId: 'TGT',
      objectApiName: 'Account',
      kind: 'document' as const,
      sourceId: fakeId('069', 1),
      targetId: fakeId('069', 9),
      linked: [fakeId('001', 9)],
      copiedAt: '2026-10-14T08:01:00.000Z',
    };
    const seen: unknown[] = [];
    engine.run = async (deps, config) => {
      // What the engine finds of the configuration's earlier runs.
      seen.push({
        delta: deps.deltaStore?.load(config.id),
        files: deps.files?.store.load(config.id),
        reads: deps.deltaReads !== undefined,
      });
      deps.deltaStore?.record(config.id, watermark);
      deps.files?.store.record(config.id, file1);
      deps.creations?.note('Account', [fakeId('001', 9)]);
      return answered(config);
    };

    await run();
    expect(JSON.parse(stdout)).toMatchObject({
      configId: 'cfg-accounts',
      created: { objects: [{ objectApiName: 'Account', ids: [fakeId('001', 9)] }] },
    });

    stdout = '';
    await run();

    expect(seen).toEqual([
      { delta: { kind: 'none' }, files: { kind: 'none' }, reads: true },
      {
        delta: { kind: 'stored', state: { version: 1, entries: [watermark] } },
        files: { kind: 'stored', map: { version: 1, entries: [file1] } },
        reads: true,
      },
    ]);
    // Kept as the panel keeps a saved configuration, between the orgs of the line.
    expect(savedConfigStore(store).load('cfg-accounts')).toMatchObject({
      sourceOrgId: 'SRC',
      targetOrgId: 'TGT',
      mode: 'delta',
    });
  });

  /** Both connections, the target saying what it is, as `typeTarget` asks it. */
  function orgSays(org: { IsSandbox: boolean; OrganizationType?: string }) {
    const destroy = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, success: true })));
    const sobject = vi.fn(() => ({ destroy }));
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async (soql: string) => ({
        records: [
          soql.includes('OrganizationType')
            ? { OrganizationType: org.OrganizationType }
            : { Id: '00D000000000002AAA', IsSandbox: org.IsSandbox },
        ],
        totalSize: 1,
      })),
      queryMore: vi.fn(),
      sobject,
    } as unknown as Connection);
    return { destroy, sobject };
  }

  it('replaces a changed attachment on a sandbox, deleting its earlier copy as the panel does', async () => {
    const { destroy, sobject } = orgSays({ IsSandbox: true });
    engine.run = async (_deps, config) => answered(config);

    await run();

    const deleteFromTarget = engine.deps[0].files?.deleteFromTarget;
    expect(deleteFromTarget).toBeDefined();
    await expect(deleteFromTarget?.('Attachment', [fakeId('00P', 1)])).resolves.toEqual([
      { id: fakeId('00P', 1), success: true, errors: [] },
    ]);
    expect(sobject).toHaveBeenCalledWith('Attachment');
    expect(destroy).toHaveBeenCalledWith([fakeId('00P', 1)]);
  });

  it('replaces a changed attachment in a Developer Edition, which holds nobody’s business, as on a sandbox', async () => {
    orgSays({ IsSandbox: false, OrganizationType: 'Developer Edition' });
    engine.run = async (_deps, config) => answered(config);

    await run();

    expect(engine.deps[0].files?.deleteFromTarget).toBeDefined();
  });

  it('writes nothing to a production org, refused before its run reaches the engine, as the clone is', async () => {
    // The gate's policy for a command line never read the type it was
    // handed: a production target took the run's inserts and updates, and
    // --remove, which refuses such an org, could not take them back.
    orgSays({ IsSandbox: false, OrganizationType: 'Enterprise Edition' });
    engine.run = async (_deps, config) => answered(config);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(run()).rejects.toThrow('exit 1');

    expect(engine.deps).toEqual([]);
    expect(stderr).toContain(
      'TGT is a production org (its Organization record says IsSandbox false, edition ' +
        'Enterprise Edition): sandforge-sync writes to sandboxes and Developer Edition orgs only. ' +
        'Nothing was written',
    );
    expect(stdout).toBe('');
  });

  it("lists a French target's validation rules with their field by its API name, as the panel does", async () => {
    const tooling = vi.fn(async (soql: string) => ({
      done: true,
      totalSize: 1,
      records: soql.includes('FROM FieldDefinition')
        ? [{ QualifiedApiName: 'Email', Label: 'Adresse e-mail' }]
        : [
            {
              ValidationName: 'Email_Required',
              ErrorMessage: 'Un e-mail est requis.',
              // As a French org answers it: the field's label.
              ErrorDisplayField: 'Adresse e-mail',
              EntityDefinition: { QualifiedApiName: 'Contact' },
            },
          ],
    }));
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async () => ({
        records: [{ Id: '00D000000000002AAA', IsSandbox: true }],
        totalSize: 1,
      })),
      queryMore: vi.fn(),
      tooling: { query: tooling, queryMore: vi.fn() },
    } as unknown as Connection);
    engine.run = async (_deps, config) => answered(config);

    await run();

    await expect(engine.deps[0].readValidationRules?.(['Contact'])).resolves.toEqual([
      {
        objectApiName: 'Contact',
        name: 'Email_Required',
        message: 'Un e-mail est requis.',
        field: 'Email',
      },
    ]);
  });

  it('reads each rule formula on the target, and marks a rule that refuses only a change', async () => {
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async () => ({
        records: [{ Id: '00D000000000002AAA', IsSandbox: true }],
        totalSize: 1,
      })),
      queryMore: vi.fn(),
      version: '66.0',
      request: vi.fn(async () => ({
        compositeResponse: [
          {
            referenceId: 'q0',
            httpStatusCode: 200,
            body: { records: [{ Metadata: { errorConditionFormula: 'NOT(ISNEW())' } }] },
          },
        ],
      })),
      tooling: {
        query: vi.fn(async (soql: string) => ({
          done: true,
          totalSize: 1,
          records: soql.includes('FROM FieldDefinition')
            ? []
            : [
                {
                  Id: '03d000000000001AAA',
                  ValidationName: 'Locked_Once_Created',
                  ErrorMessage: 'Locked.',
                  EntityDefinition: { QualifiedApiName: 'Contact' },
                },
              ],
        })),
        queryMore: vi.fn(),
      },
    } as unknown as Connection);
    engine.run = async (_deps, config) => answered(config);

    await run();

    await expect(engine.deps[0].readValidationRules?.(['Contact'])).resolves.toEqual([
      {
        objectApiName: 'Contact',
        name: 'Locked_Once_Created',
        message: 'Locked.',
        onChangeOnly: true,
      },
    ]);
  });

  it('keeps in the store which record of the target each record a run wrote became, for the next run', async () => {
    const orgs = { sourceOrgId: 'SRC', targetOrgId: 'TGT' };
    const seen: Array<ReadonlyMap<string, string> | null | undefined> = [];
    engine.run = async (deps, config) => {
      seen.push(await deps.idMap?.load(config.id, orgs));
      await deps.idMap?.record(config.id, orgs, 'Account', [[fakeId('001', 1), fakeId('001', 9)]]);
      return answered(config);
    };

    await run();
    await run();

    expect(seen).toEqual([new Map(), new Map([[fakeId('001', 1).slice(0, 15), fakeId('001', 9)]])]);
  });

  it('dates in its summary when the run first wrote, an update before its first creation included', async () => {
    // The sweep of its removal starts there: the tasks the target's flows
    // opened on what it updated first were left out of a window that began
    // at its first creation.
    const ACCOUNT = fakeId('001', 1);
    const CONTACT = fakeId('003', 1);
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async () => ({
        records: [{ Id: '00D000000000002AAA', IsSandbox: true }],
        totalSize: 1,
      })),
      queryMore: vi.fn(),
      sobject: () => ({
        update: vi.fn(async (rows: Array<{ Id: string }>) =>
          rows.map((row) => ({ id: row.Id, success: true, errors: [] })),
        ),
      }),
    } as unknown as Connection);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      engine.run = async (deps, config) => {
        vi.setSystemTime(new Date('2026-10-14T08:00:02.000Z'));
        // The writer's first call: an update of a record the target held.
        await deps.dataSync.setLookups(
          { objectApiName: 'Account', batchSize: 200 },
          [{ id: ACCOUNT, field: 'ParentId', parent: fakeId('001', 2) }],
          {
            targetOf: () => fakeId('001', 3),
            refusedObjectOf: () => undefined,
          } as unknown as Parameters<typeof deps.dataSync.setLookups>[2],
          false,
        );
        vi.setSystemTime(new Date('2026-10-14T08:00:09.000Z'));
        deps.creations?.note('Contact', [CONTACT]);
        return answered(config);
      };

      await main(argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account', '--json'));
    } finally {
      vi.useRealTimers();
    }

    expect(JSON.parse(stdout).created).toMatchObject({
      firstWrittenAt: '2026-10-14T08:00:02.000Z',
      lastWrittenAt: '2026-10-14T08:00:09.000Z',
      objects: [{ objectApiName: 'Contact', ids: [CONTACT] }],
    });
  });

  it('keeps nothing for a run of the objects of the line, which is never run again', async () => {
    engine.run = async (_deps, config) => answered(config);

    await main(argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account', '--json'));

    expect(engine.deps[0].deltaStore).toBeUndefined();
    expect(engine.deps[0].deltaReads).toBeUndefined();
    expect(engine.deps[0].idMap).toBeUndefined();
    expect(JSON.parse(stdout).configId).toBeUndefined();
  });

  it('refuses a configuration the panel would refuse, before any org is contacted', async () => {
    writeFileSync(file, JSON.stringify({ ...SAVED, conflictStrategy: 'manual' }));
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(run()).rejects.toThrow('exit 2');

    expect(stderr).toContain('conflictStrategy: Manual conflict review is not available');
    expect(makeConn).not.toHaveBeenCalled();
  });
});
