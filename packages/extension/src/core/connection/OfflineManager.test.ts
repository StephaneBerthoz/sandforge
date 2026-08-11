import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OfflineManager } from './OfflineManager';
import type { QueuedOperation, OfflineEventListener, OperationExecutor } from './OfflineManager';
import { ConfigStore } from '../storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../storage/ConfigStoreBackend';

function createOperation(
  id: string,
  overrides?: Partial<QueuedOperation>,
): Omit<QueuedOperation, 'queuedAt' | 'retryCount'> {
  return {
    id,
    type: 'seed:execute',
    orgId: 'org-1',
    payload: { template: 'test' },
    ...overrides,
  };
}

describe('OfflineManager', () => {
  let store: ConfigStore;
  let manager: OfflineManager;

  beforeEach(() => {
    vi.useFakeTimers();
    const backend = new InMemoryConfigStoreBackend();
    store = new ConfigStore(backend);
    store.initialize();
    manager = new OfflineManager(store);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe('connectivity status', () => {
    it('should default to online', () => {
      expect(manager.getStatus()).toBe('online');
      expect(manager.isOffline()).toBe(false);
    });

    it('should detect offline via probe', async () => {
      manager.setProbeExecutor(async () => false);

      const status = await manager.checkConnectivity();

      expect(status).toBe('offline');
      expect(manager.isOffline()).toBe(true);
    });

    it('should detect online via probe', async () => {
      manager.setStatus('offline');
      manager.setProbeExecutor(async () => true);

      const status = await manager.checkConnectivity();

      expect(status).toBe('online');
      expect(manager.isOffline()).toBe(false);
    });

    it('should go offline when probe throws', async () => {
      manager.setProbeExecutor(async () => {
        throw new Error('Network error');
      });

      const status = await manager.checkConnectivity();

      expect(status).toBe('offline');
    });

    it('should return current status when no probe executor', async () => {
      const status = await manager.checkConnectivity();
      expect(status).toBe('online');
    });

    it('should emit statusChanged event', async () => {
      const listener: OfflineEventListener = vi.fn();
      manager.onEvent(listener);
      manager.setProbeExecutor(async () => false);

      await manager.checkConnectivity();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'statusChanged',
          status: 'offline',
          previousStatus: 'online',
        }),
      );
    });

    it('should not emit when status unchanged', async () => {
      const listener: OfflineEventListener = vi.fn();
      manager.onEvent(listener);
      manager.setProbeExecutor(async () => true);

      await manager.checkConnectivity();

      expect(listener).not.toHaveBeenCalled();
    });

    it('should support manual status override', () => {
      const listener: OfflineEventListener = vi.fn();
      manager.onEvent(listener);

      manager.setStatus('offline');

      expect(manager.isOffline()).toBe(true);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'statusChanged', status: 'offline' }),
      );
    });
  });

  describe('periodic probing', () => {
    it('should probe at the configured interval', async () => {
      let probeCount = 0;
      manager.setProbeExecutor(async () => {
        probeCount++;
        return true;
      });

      manager.startProbing(10_000);

      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(probeCount).toBeGreaterThanOrEqual(3);
    });

    it('should stop probing', () => {
      let probeCount = 0;
      manager.setProbeExecutor(async () => {
        probeCount++;
        return true;
      });

      manager.startProbing(10_000);
      manager.stopProbing();

      vi.advanceTimersByTime(30_000);

      expect(probeCount).toBe(0);
    });

    it('should replace previous probe timer', () => {
      let probeCount = 0;
      manager.setProbeExecutor(async () => {
        probeCount++;
        return true;
      });

      manager.startProbing(10_000);
      manager.startProbing(10_000);

      vi.advanceTimersByTime(10_000);
      // Only one interval should be running
      expect(probeCount).toBeLessThanOrEqual(2);
    });
  });

  describe('operation queue', () => {
    it('should enqueue operations', () => {
      const result = manager.enqueue(createOperation('op-1'));

      expect(result).toBe(true);
      expect(manager.getQueueSize()).toBe(1);
    });

    it('should reject when queue is full', () => {
      const smallManager = new OfflineManager(store, 2);

      smallManager.enqueue(createOperation('op-1'));
      smallManager.enqueue(createOperation('op-2'));
      const result = smallManager.enqueue(createOperation('op-3'));

      expect(result).toBe(false);
      expect(smallManager.getQueueSize()).toBe(2);

      smallManager.dispose();
    });

    it('should return queue contents', () => {
      manager.enqueue(createOperation('op-1'));
      manager.enqueue(createOperation('op-2'));

      const queue = manager.getQueue();
      expect(queue).toHaveLength(2);
      expect(queue[0].id).toBe('op-1');
      expect(queue[1].id).toBe('op-2');
    });

    it('should set queuedAt and retryCount on enqueue', () => {
      manager.enqueue(createOperation('op-1'));

      const queue = manager.getQueue();
      expect(queue[0].queuedAt).toBeDefined();
      expect(queue[0].retryCount).toBe(0);
    });

    it('should clear the queue', () => {
      manager.enqueue(createOperation('op-1'));
      manager.enqueue(createOperation('op-2'));

      manager.clearQueue();

      expect(manager.getQueueSize()).toBe(0);
    });

    it('should remove specific operation from queue', () => {
      manager.enqueue(createOperation('op-1'));
      manager.enqueue(createOperation('op-2'));

      const result = manager.removeFromQueue('op-1');

      expect(result).toBe(true);
      expect(manager.getQueueSize()).toBe(1);
      expect(manager.getQueue()[0].id).toBe('op-2');
    });

    it('should return false when removing non-existent operation', () => {
      expect(manager.removeFromQueue('nonexistent')).toBe(false);
    });

    it('should emit operationQueued event', () => {
      const listener: OfflineEventListener = vi.fn();
      manager.onEvent(listener);

      manager.enqueue(createOperation('op-1'));

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'operationQueued' }));
    });

    it('should persist queue to store', () => {
      manager.enqueue(createOperation('op-1'));

      // Create new manager with same store to verify persistence
      const manager2 = new OfflineManager(store);
      expect(manager2.getQueueSize()).toBe(1);
      manager2.dispose();
    });
  });

  describe('queue drain', () => {
    it('should drain queue FIFO when coming back online', async () => {
      const executionOrder: string[] = [];
      const executor: OperationExecutor = vi
        .fn()
        .mockImplementation(async (op: QueuedOperation) => {
          executionOrder.push(op.id);
        });

      manager.setOperationExecutor(executor);
      manager.enqueue(createOperation('op-1'));
      manager.enqueue(createOperation('op-2'));
      manager.enqueue(createOperation('op-3'));

      const result = await manager.drainQueue();

      expect(result.executed).toBe(3);
      expect(result.failed).toBe(0);
      expect(executionOrder).toEqual(['op-1', 'op-2', 'op-3']);
      expect(manager.getQueueSize()).toBe(0);
    });

    it('should handle failed operations during drain', async () => {
      let callCount = 0;
      const executor: OperationExecutor = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Operation failed');
        }
      });

      manager.setOperationExecutor(executor);
      manager.enqueue(createOperation('op-1'));
      manager.enqueue(createOperation('op-2'));
      manager.enqueue(createOperation('op-3'));

      const result = await manager.drainQueue();

      expect(result.executed).toBe(2);
      expect(result.failed).toBe(1);
    });

    it('should report progress during drain', async () => {
      const executor: OperationExecutor = vi.fn().mockResolvedValue(undefined);
      const progressCallback = vi.fn();

      manager.setOperationExecutor(executor);
      manager.enqueue(createOperation('op-1'));
      manager.enqueue(createOperation('op-2'));

      await manager.drainQueue(progressCallback);

      expect(progressCallback).toHaveBeenCalledWith(1, 2);
      expect(progressCallback).toHaveBeenCalledWith(2, 2);
    });

    it('should emit events during drain', async () => {
      const executor: OperationExecutor = vi.fn().mockResolvedValue(undefined);
      const listener: OfflineEventListener = vi.fn();

      manager.setOperationExecutor(executor);
      manager.onEvent(listener);
      manager.enqueue(createOperation('op-1'));

      // Clear the enqueue event
      (listener as ReturnType<typeof vi.fn>).mockClear();

      await manager.drainQueue();

      const calls = (listener as ReturnType<typeof vi.fn>).mock.calls;
      const eventTypes = calls.map((c: unknown[]) => (c[0] as { type: string }).type);
      expect(eventTypes).toContain('operationExecuted');
      expect(eventTypes).toContain('queueDrained');
    });

    it('should not drain if already draining', async () => {
      let resolveFirst: (() => void) | undefined;
      const executor: OperationExecutor = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      );

      manager.setOperationExecutor(executor);
      manager.enqueue(createOperation('op-1'));

      const drain1 = manager.drainQueue();

      expect(manager.isDraining()).toBe(true);

      const drain2Result = await manager.drainQueue();
      expect(drain2Result.executed).toBe(0);

      resolveFirst?.();
      await drain1;
    });

    it('should not drain with empty queue', async () => {
      const executor: OperationExecutor = vi.fn();
      manager.setOperationExecutor(executor);

      const result = await manager.drainQueue();

      expect(result.executed).toBe(0);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should not drain without executor', async () => {
      manager.enqueue(createOperation('op-1'));

      const result = await manager.drainQueue();

      expect(result.executed).toBe(0);
      expect(manager.getQueueSize()).toBe(1);
    });

    it('should auto-drain when coming back online', async () => {
      const executor: OperationExecutor = vi.fn().mockResolvedValue(undefined);
      manager.setOperationExecutor(executor);

      manager.enqueue(createOperation('op-1'));
      manager.setStatus('offline');

      // Coming back online should trigger drain
      manager.setProbeExecutor(async () => true);
      await manager.checkConnectivity();

      // Wait for async drain
      await Promise.resolve();
      await Promise.resolve();

      expect(executor).toHaveBeenCalled();
    });

    it('should trigger a debounced drain when enqueuing while online', async () => {
      const executor: OperationExecutor = vi.fn().mockResolvedValue(undefined);
      manager.setOperationExecutor(executor);

      manager.enqueue(createOperation('op-online'));

      // Debounced — not drained synchronously
      expect(executor).not.toHaveBeenCalled();
      expect(manager.getQueueSize()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(executor).toHaveBeenCalledTimes(1);
      expect(manager.getQueueSize()).toBe(0);
    });

    it('should NOT drain on enqueue while offline', async () => {
      const executor: OperationExecutor = vi.fn().mockResolvedValue(undefined);
      manager.setOperationExecutor(executor);
      manager.setStatus('offline');

      manager.enqueue(createOperation('op-offline'));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(executor).not.toHaveBeenCalled();
      expect(manager.getQueueSize()).toBe(1);
    });

    it('should batch burst enqueues into a single drain', async () => {
      const executor: OperationExecutor = vi.fn().mockResolvedValue(undefined);
      manager.setOperationExecutor(executor);

      manager.enqueue(createOperation('op-1'));
      await vi.advanceTimersByTimeAsync(500);
      manager.enqueue(createOperation('op-2'));

      await vi.advanceTimersByTimeAsync(1_000);

      // One drain pass executed both operations FIFO
      expect(executor).toHaveBeenCalledTimes(2);
      expect(manager.getQueueSize()).toBe(0);
    });

    it('should drain a persisted queue once the executor is wired at boot', async () => {
      // Simulate a crashed session: the store already holds a parked operation
      // before the manager is constructed (status starts 'online').
      store.set(
        'offline:queue',
        [
          {
            id: 'op-stale',
            type: 'sync',
            orgId: 'org-1',
            payload: {},
            queuedAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
        'offline-queue',
      );
      const booted = new OfflineManager(store);
      const executor: OperationExecutor = vi.fn().mockResolvedValue(undefined);

      booted.setOperationExecutor(executor);

      // Debounced — not drained synchronously
      expect(executor).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(executor).toHaveBeenCalledTimes(1);
      expect(booted.getQueueSize()).toBe(0);
      booted.dispose();
    });

    it('should not schedule a boot drain when the persisted queue is empty', async () => {
      const booted = new OfflineManager(store);
      const executor: OperationExecutor = vi.fn().mockResolvedValue(undefined);

      booted.setOperationExecutor(executor);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(executor).not.toHaveBeenCalled();
      expect(booted.isDraining()).toBe(false);
      booted.dispose();
    });

    it('should release the draining flag when the progress callback throws', async () => {
      const executor: OperationExecutor = vi.fn().mockResolvedValue(undefined);
      manager.setOperationExecutor(executor);
      manager.enqueue(createOperation('op-1'));

      await expect(
        manager.drainQueue(() => {
          throw new Error('progress boom');
        }),
      ).rejects.toThrow('progress boom');

      // The flag is released, so a later drain still runs.
      expect(manager.isDraining()).toBe(false);

      manager.enqueue(createOperation('op-2'));
      const result = await manager.drainQueue();
      expect(result.executed).toBe(1);
    });
  });

  describe('events', () => {
    it('should register and unregister listeners', () => {
      const listener: OfflineEventListener = vi.fn();

      manager.onEvent(listener);
      manager.enqueue(createOperation('op-1'));
      expect(listener).toHaveBeenCalledTimes(1);

      manager.offEvent(listener);
      manager.enqueue(createOperation('op-2'));
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should isolate a throwing listener from the other listeners', () => {
      const badListener: OfflineEventListener = vi.fn(() => {
        throw new Error('listener boom');
      });
      const goodListener: OfflineEventListener = vi.fn();

      manager.onEvent(badListener);
      manager.onEvent(goodListener);

      expect(() => manager.enqueue(createOperation('op-1'))).not.toThrow();
      expect(badListener).toHaveBeenCalledTimes(1);
      expect(goodListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('queue persistence validation', () => {
    it('should drop malformed entries loaded from storage', () => {
      store.set(
        'offline:queue',
        [
          {
            id: 'op-good',
            type: 'sync',
            orgId: 'org-1',
            payload: {},
            queuedAt: new Date().toISOString(),
            retryCount: 0,
          },
          null,
          'not-an-object',
          { id: 42, type: 'sync', orgId: 'org-1', payload: {} },
          { id: 'op-no-payload', type: 'sync', orgId: 'org-1' },
        ],
        'offline-queue',
      );

      const reloaded = new OfflineManager(store);

      expect(reloaded.getQueueSize()).toBe(1);
      expect(reloaded.getQueue()[0].id).toBe('op-good');
      reloaded.dispose();
    });

    it('should backfill missing queuedAt/retryCount on load', () => {
      store.set(
        'offline:queue',
        [{ id: 'op-legacy', type: 'sync', orgId: 'org-1', payload: {} }],
        'offline-queue',
      );

      const reloaded = new OfflineManager(store);

      const entry = reloaded.getQueue()[0];
      expect(entry.queuedAt).toBeDefined();
      expect(entry.retryCount).toBe(0);
      reloaded.dispose();
    });
  });

  describe('dispose', () => {
    it('should stop probing and clear listeners', () => {
      let probeCount = 0;
      manager.setProbeExecutor(async () => {
        probeCount++;
        return true;
      });
      manager.startProbing(10_000);

      manager.dispose();

      vi.advanceTimersByTime(30_000);
      expect(probeCount).toBe(0);
    });

    it('should purge a pending drain timer so the executor never fires after dispose', async () => {
      const executor = vi.fn<OperationExecutor>();
      executor.mockResolvedValue(undefined);
      manager.setOperationExecutor(executor);

      // Enqueue while online schedules a debounced drain (1 s).
      manager.enqueue(createOperation('op-drain'));

      manager.dispose();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(executor).not.toHaveBeenCalled();
    });
  });
});
