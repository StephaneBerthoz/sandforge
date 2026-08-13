import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import type { BaseMessage } from '@sandforge/shared';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * Backup record payloads must reach the file store, not globalState.
 *
 * The handler keeps writing the backup *meta* to ConfigStore — it is small and
 * it is what the history list reads — but the record sets themselves are what
 * made every unrelated `configStore.set()` re-serialize megabytes.
 */

interface Harness {
  handler: DataOpsHandler;
  deps: HandlerDeps;
  store: {
    save: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  config: Map<string, unknown>;
}

function createHarness(withStore = true): Harness {
  let idCounter = 0;
  const config = new Map<string, unknown>();
  const deps = {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    stateSync: {},
    orgManager: { getOrg: vi.fn() },
    orgRegistry: {},
    configStore: {
      get: vi.fn((key: string) => config.get(key)),
      set: vi.fn((key: string, value: unknown) => config.set(key, value)),
      delete: vi.fn((key: string) => config.delete(key)),
      keys: vi.fn(() => Array.from(config.keys())),
    },
    secretVault: {},
    authProvider: {},
    sfdxBridge: {},
    nextId: () => String(++idCounter),
  } as unknown as HandlerDeps;

  const store = {
    save: vi.fn(async () => undefined),
    read: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
  };

  const handler = new DataOpsHandler(deps);
  if (withStore) handler.setBackupRecordStore(store as unknown as BackupRecordStore);
  return { handler, deps, store, config };
}

const RECORDS = [{ Id: '001a', Name: 'Acme' }];

function mockConnection(): void {
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: vi.fn().mockResolvedValue({ records: RECORDS, done: true }),
    describe: vi.fn().mockResolvedValue({
      name: 'Account',
      createable: true,
      updateable: true,
      deletable: true,
      queryable: true,
      fields: [{ name: 'Name', createable: true, updateable: true }],
    }),
    sobject: vi.fn(() => ({ upsert: vi.fn().mockResolvedValue([{ success: true, id: '001a' }]) })),
  } as never);
}

function backupMsg(id: string): BaseMessage & { payload: Record<string, unknown> } {
  return {
    id,
    type: 'dataops:backup',
    timestamp: Date.now(),
    payload: { orgId: 'org-1', objects: ['Account'] },
  };
}

describe('DataOpsHandler backup record storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection();
  });

  it('writes record payloads to the file store, not to ConfigStore', async () => {
    const { handler, deps, store } = createHarness();

    await handler.handle(backupMsg('req-1'));

    expect(store.save).toHaveBeenCalledWith(expect.any(String), 'Account', RECORDS);
    const configKeys = (deps.configStore.set as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    // Meta still lands in ConfigStore; the per-object record key must not.
    expect(configKeys.some((k) => k.startsWith('backup:'))).toBe(true);
    expect(configKeys.some((k) => k.includes(':Account'))).toBe(false);
  });

  it('falls back to ConfigStore when no store is injected', async () => {
    // Keeps the handler usable in tests and in any composition that skips the
    // late-injection step, rather than silently dropping the records.
    const { handler, deps } = createHarness(false);

    await handler.handle(backupMsg('req-1'));

    const configKeys = (deps.configStore.set as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(configKeys.some((k) => k.includes(':Account'))).toBe(true);
  });

  it('rollback restores the records read from the file store', async () => {
    const { handler, store, config } = createHarness();
    config.set('backup:op-9', {
      operationId: 'op-9',
      orgId: 'org-1',
      objects: [{ objectApiName: 'Account', recordCount: 1 }],
      totalRecords: 1,
    });
    store.read.mockResolvedValue(RECORDS);

    await handler.handle({
      id: 'req-2',
      type: 'dataops:rollback',
      timestamp: Date.now(),
      payload: { orgId: 'org-1', operationId: 'op-9' },
    } as BaseMessage);

    expect(store.read).toHaveBeenCalledWith('op-9', 'Account');
    expect(vi.mocked(getJsforceConnection).mock.results.length).toBeGreaterThan(0);
  });

  it('rollback still reads backups written before the file store existed', async () => {
    const { handler, deps, store, config } = createHarness();
    config.set('backup:op-old', {
      operationId: 'op-old',
      orgId: 'org-1',
      objects: [{ objectApiName: 'Account', recordCount: 1 }],
      totalRecords: 1,
    });
    config.set('backup:op-old:Account', RECORDS);
    store.read.mockResolvedValue(null);

    await handler.handle({
      id: 'req-3',
      type: 'dataops:rollback',
      timestamp: Date.now(),
      payload: { orgId: 'org-1', operationId: 'op-old' },
    } as BaseMessage);

    expect(deps.configStore.get).toHaveBeenCalledWith('backup:op-old:Account');
    // No "nothing to restore" bail-out — the legacy records were found.
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('No backup records'));
  });
});
