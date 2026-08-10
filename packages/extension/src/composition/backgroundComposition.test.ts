import { describe, it, expect, vi, beforeEach } from 'vitest';

// backgroundComposition imports vscode for ProductionGuard confirmations —
// none of that runs in these tests.
vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

import * as vscode from 'vscode';
import { wireOfflineNotifications, wireOfflineReplay } from './backgroundComposition';
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

  it('drains an operation enqueued while already online (failed replay re-enqueue)', async () => {
    const manager = new OfflineManager(createMockConfigStore());
    const replay = vi.fn().mockResolvedValue(undefined);
    const handlers = { replayQueuedOperation: replay } as unknown as ExtensionHandlers;

    wireOfflineReplay(manager, handlers);

    // Status is 'online' by default: the enqueue must schedule a drain on its
    // own, without waiting for an offline→online transition.
    manager.enqueue({ id: 'q-3', type: 'sync', orgId: 'org-1', payload: { config: {} } });

    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(manager.getQueueSize()).toBe(0));
    manager.dispose();
  });
});

describe('wireOfflineNotifications', () => {
  beforeEach(() => {
    vi.mocked(vscode.window.showInformationMessage).mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
  });

  it('notifies when an operation is queued', () => {
    const manager = new OfflineManager(createMockConfigStore());
    wireOfflineNotifications(manager);

    manager.enqueue({ id: 'q-1', type: 'sync', orgId: 'org-1', payload: {} });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('queued'),
    );
    manager.dispose();
  });

  it('notifies when a queued operation is replayed', async () => {
    const manager = new OfflineManager(createMockConfigStore());
    wireOfflineNotifications(manager);
    manager.setOperationExecutor(vi.fn().mockResolvedValue(undefined));

    manager.setStatus('offline');
    manager.enqueue({ id: 'q-2', type: 'sync', orgId: 'org-1', payload: {} });
    await manager.drainQueue();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('replayed'),
    );
    manager.dispose();
  });

  it('warns when a queued operation fails to replay', async () => {
    const manager = new OfflineManager(createMockConfigStore());
    wireOfflineNotifications(manager);
    manager.setOperationExecutor(vi.fn().mockRejectedValue(new Error('replay boom')));

    manager.setStatus('offline');
    manager.enqueue({ id: 'q-3', type: 'sync', orgId: 'org-1', payload: {} });
    await manager.drainQueue();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('dropped'),
    );
    manager.dispose();
  });
});
