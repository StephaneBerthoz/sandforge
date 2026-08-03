import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncHistoryHandler } from './SyncHistoryHandler';
import { SyncHistoryStore } from '../../modules/sync/SyncHistoryStore';
import type { SyncOpsHandler } from './SyncOpsHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage, SyncHistoryEntry } from '@sandforge/shared';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { ConfigStoreBackend, ConfigEntry } from '../../core/storage/ConfigStoreBackend';

class InMemoryBackend implements ConfigStoreBackend {
  private data: Record<string, ConfigEntry> = {};
  getData(): Record<string, ConfigEntry> {
    return { ...this.data };
  }
  setData(data: Record<string, ConfigEntry>): void {
    this.data = { ...data };
  }
}

function createMockDeps(store: ConfigStore): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {} as HandlerDeps['orgManager'],
    orgRegistry: {} as HandlerDeps['orgRegistry'],
    configStore: store,
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id'),
  };
}

function createMsg(
  type: string,
  payload: Record<string, unknown> = {},
): BaseMessage & { payload: Record<string, unknown> } {
  return { id: 'req-9', type, timestamp: Date.now(), payload };
}

function fakeEntry(id: string, name: string): SyncHistoryEntry {
  return {
    id,
    configSnapshot: { id: 'cfg-1', name } as unknown as SyncHistoryEntry['configSnapshot'],
    result: {
      configId: 'cfg-1',
      operationId: 'op-1',
      status: 'success',
      objectResults: [],
      totalProcessed: 10,
      totalSuccess: 10,
      totalFailed: 0,
      totalSkipped: 0,
      duration: 1000,
      timestamp: '2026-01-01T00:00:01.000Z',
    },
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:01.000Z',
    triggeredBy: 'manual',
  };
}

describe('SyncHistoryHandler', () => {
  let store: ConfigStore;
  let historyStore: SyncHistoryStore;
  let deps: HandlerDeps;
  let syncOps: { rerunFromSnapshot: ReturnType<typeof vi.fn> };
  let handler: SyncHistoryHandler;

  beforeEach(() => {
    store = new ConfigStore(new InMemoryBackend());
    store.initialize();
    historyStore = new SyncHistoryStore(store);
    deps = createMockDeps(store);
    syncOps = { rerunFromSnapshot: vi.fn().mockResolvedValue(undefined) };
    handler = new SyncHistoryHandler(deps, historyStore, syncOps as unknown as SyncOpsHandler);
  });

  function lastPosted(): BaseMessage & { payload: Record<string, unknown> } {
    const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][0] as BaseMessage & { payload: Record<string, unknown> };
  }

  it('returns false for unknown message types', async () => {
    expect(await handler.handle(createMsg('sync:execute'))).toBe(false);
  });

  it('lists entries newest first', async () => {
    historyStore.save(fakeEntry('e-1', 'first'));
    historyStore.save({ ...fakeEntry('e-2', 'second'), startTime: '2026-02-01T00:00:00.000Z' });

    expect(await handler.handle(createMsg('sync:history:list'))).toBe(true);

    const response = lastPosted();
    expect(response.type).toBe('sync:history:list:response');
    const entries = response.payload['entries'] as Array<{ id: string }>;
    expect(entries.map((e) => e.id)).toEqual(['e-2', 'e-1']);
  });

  it('returns the requested entry on detail', async () => {
    historyStore.save(fakeEntry('e-1', 'first'));

    await handler.handle(createMsg('sync:history:detail', { entryId: 'e-1' }));

    const response = lastPosted();
    expect(response.type).toBe('sync:history:detail:response');
    expect((response.payload['entry'] as { id: string }).id).toBe('e-1');
  });

  it('exports CSV with the store columns', async () => {
    historyStore.save(fakeEntry('e-1', 'Nightly, sync'));

    await handler.handle(createMsg('sync:history:export', { format: 'csv' }));

    const response = lastPosted();
    expect(response.type).toBe('sync:history:export:response');
    const data = response.payload['data'] as string;
    expect(response.payload['format']).toBe('csv');
    expect(data).toContain('id,configName,status');
    // The comma in the config name is quoted by the CSV escaper.
    expect(data).toContain('"Nightly, sync"');
  });

  it('exports JSON', async () => {
    historyStore.save(fakeEntry('e-1', 'first'));

    await handler.handle(createMsg('sync:history:export', { format: 'json', entryIds: ['e-1'] }));

    const response = lastPosted();
    const parsed = JSON.parse(response.payload['data'] as string) as Array<{ id: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('e-1');
  });

  it('delegates rerun to SyncOpsHandler with the stored config snapshot', async () => {
    const entry = fakeEntry('e-1', 'first');
    historyStore.save(entry);

    await handler.handle(createMsg('sync:history:rerun', { entryId: 'e-1' }));

    expect(syncOps.rerunFromSnapshot).toHaveBeenCalledTimes(1);
    const callArgs = syncOps.rerunFromSnapshot.mock.calls[0];
    expect(callArgs[1]).toEqual(entry.configSnapshot);
  });

  it('answers NOT_FOUND on rerun of an unknown entry', async () => {
    await handler.handle(createMsg('sync:history:rerun', { entryId: 'nope' }));

    const response = lastPosted();
    expect(response.type).toBe('sync:history:error');
    expect(response.payload['code']).toBe('NOT_FOUND');
    expect(syncOps.rerunFromSnapshot).not.toHaveBeenCalled();
  });

  it('rejects an invalid export payload with INVALID_PAYLOAD', async () => {
    await handler.handle(createMsg('sync:history:export', { format: 'pdf' }));

    const response = lastPosted();
    expect(response.type).toBe('sync:history:error');
    expect(response.payload['code']).toBe('INVALID_PAYLOAD');
  });
});
