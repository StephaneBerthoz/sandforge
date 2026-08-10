import { describe, it, expect, vi } from 'vitest';

// backgroundComposition imports vscode for ProductionGuard confirmations —
// none of that runs in these tests.
vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
  },
}));

import { wireOfflineReplay } from './backgroundComposition';
import { OfflineManager } from '../core/connection/OfflineManager';
import type { ConfigStore } from '../core/storage/ConfigStore';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';

function createMockConfigStore(): ConfigStore {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string): T | undefined => data.get(key) as T | undefined),
    set: vi.fn((key: string, value: unknown): void => {
      data.set(key, value);
    }),
  } as unknown as ConfigStore;
}

describe('wireOfflineReplay', () => {
  it('replays queued operations through the handlers when connectivity returns', async () => {
    const manager = new OfflineManager(createMockConfigStore());
    const replay = vi.fn().mockResolvedValue(undefined);
    const handlers = { replayQueuedOperation: replay } as unknown as ExtensionHandlers;

    wireOfflineReplay(manager, handlers);

    manager.enqueue({ id: 'q-1', type: 'sync', orgId: 'tgt-org', payload: { config: {} } });
    manager.setStatus('offline');
    // Coming back online drains the queue through the wired executor.
    manager.setStatus('online');

    // Wait for the full drain (the queue shift happens after the executor
    // promise resolves).
    await vi.waitFor(() => expect(manager.getQueueSize()).toBe(0));
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay.mock.calls[0][0].id).toBe('q-1');
    manager.dispose();
  });

  it('keeps the queue parked while no executor outcome is possible (offline)', () => {
    const manager = new OfflineManager(createMockConfigStore());
    const replay = vi.fn().mockResolvedValue(undefined);
    const handlers = { replayQueuedOperation: replay } as unknown as ExtensionHandlers;

    wireOfflineReplay(manager, handlers);

    manager.enqueue({ id: 'q-2', type: 'seed', orgId: 'org-1', payload: {} });
    manager.setStatus('offline');

    expect(replay).not.toHaveBeenCalled();
    expect(manager.getQueueSize()).toBe(1);
    manager.dispose();
  });
});
