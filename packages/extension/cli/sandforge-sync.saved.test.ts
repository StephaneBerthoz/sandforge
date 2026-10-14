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
      query: vi.fn(async () => ({ records: [{ Id: '00D000000000002AAA' }], totalSize: 1 })),
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

  it('keeps nothing for a run of the objects of the line, which is never run again', async () => {
    engine.run = async (_deps, config) => answered(config);

    await main(argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account', '--json'));

    expect(engine.deps[0].deltaStore).toBeUndefined();
    expect(engine.deps[0].deltaReads).toBeUndefined();
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
