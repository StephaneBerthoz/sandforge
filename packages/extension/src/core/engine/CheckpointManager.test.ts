import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CheckpointManager } from './CheckpointManager';
import type { OperationCheckpoint, CheckpointEventListener } from './CheckpointManager';
import { ConfigStore } from '../storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../storage/ConfigStoreBackend';

function createCheckpoint(
  operationId: string,
  overrides?: Partial<OperationCheckpoint>,
): OperationCheckpoint {
  return {
    operationId,
    status: 'in_progress',
    objectName: 'Account',
    totalRecords: 100,
    processedRecords: 50,
    successCount: 48,
    failureCount: 2,
    createdAt: '2026-02-20T00:00:00.000Z',
    updatedAt: '2026-02-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('CheckpointManager', () => {
  let store: ConfigStore;
  let manager: CheckpointManager;

  beforeEach(() => {
    vi.useFakeTimers();
    const backend = new InMemoryConfigStoreBackend();
    store = new ConfigStore(backend);
    store.initialize();
    manager = new CheckpointManager(store);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe('save', () => {
    it('should save a checkpoint', () => {
      const checkpoint = createCheckpoint('op-1');
      manager.save('op-1', checkpoint);

      expect(manager.has('op-1')).toBe(true);
    });

    it('should overwrite an existing checkpoint', () => {
      manager.save('op-1', createCheckpoint('op-1', { processedRecords: 10 }));
      manager.save('op-1', createCheckpoint('op-1', { processedRecords: 50 }));

      const restored = manager.restore('op-1');
      expect(restored?.processedRecords).toBe(50);
    });

    it('should emit saved event', () => {
      const listener = vi.fn();
      manager.onEvent(listener);

      manager.save('op-1', createCheckpoint('op-1'));

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'saved', operationId: 'op-1' }),
      );
    });
  });

  describe('restore / load', () => {
    it('should restore a saved checkpoint', () => {
      const checkpoint = createCheckpoint('op-1');
      manager.save('op-1', checkpoint);

      const restored = manager.restore('op-1');
      expect(restored).not.toBeNull();
      expect(restored?.operationId).toBe('op-1');
      expect(restored?.processedRecords).toBe(50);
    });

    it('should return null for unknown operation', () => {
      expect(manager.restore('nonexistent')).toBeNull();
    });

    it('should return null for expired checkpoint', () => {
      manager.save('op-1', createCheckpoint('op-1'));

      // Advance past 24h retention
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(manager.restore('op-1')).toBeNull();
    });

    it('should emit restored event', () => {
      manager.save('op-1', createCheckpoint('op-1'));

      const listener = vi.fn();
      manager.onEvent(listener);

      manager.restore('op-1');

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'restored', operationId: 'op-1' }),
      );
    });

    it('load should be an alias for restore', () => {
      manager.save('op-1', createCheckpoint('op-1'));

      const loaded = manager.load('op-1');
      expect(loaded).not.toBeNull();
      expect(loaded?.operationId).toBe('op-1');
    });
  });

  describe('list', () => {
    it('should list all non-expired checkpoints', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      manager.save('op-2', createCheckpoint('op-2'));

      const list = manager.list();
      expect(list).toHaveLength(2);
    });

    it('should exclude expired checkpoints', () => {
      manager.save('op-1', createCheckpoint('op-1'));

      vi.advanceTimersByTime(12 * 60 * 60 * 1000); // 12h

      manager.save('op-2', createCheckpoint('op-2'));

      vi.advanceTimersByTime(13 * 60 * 60 * 1000); // +13h = 25h total for op-1

      const list = manager.list();
      expect(list).toHaveLength(1);
      expect(list[0].operationId).toBe('op-2');
    });

    it('should return empty array when no checkpoints', () => {
      expect(manager.list()).toEqual([]);
    });
  });

  describe('listAll', () => {
    it('should list all checkpoints including expired', () => {
      manager.save('op-1', createCheckpoint('op-1'));

      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // expire op-1

      manager.save('op-2', createCheckpoint('op-2'));

      const all = manager.listAll();
      expect(all).toHaveLength(2);
    });

    it('should return empty array when no checkpoints', () => {
      expect(manager.listAll()).toEqual([]);
    });
  });

  describe('getExpired', () => {
    it('should return only expired checkpoints', () => {
      manager.save('op-1', createCheckpoint('op-1'));

      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // expire op-1

      manager.save('op-2', createCheckpoint('op-2'));

      const expired = manager.getExpired();
      expect(expired).toHaveLength(1);
      expect(expired[0].operationId).toBe('op-1');
    });

    it('should return empty array when nothing expired', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      expect(manager.getExpired()).toEqual([]);
    });
  });

  describe('delete / clear', () => {
    it('should delete a checkpoint', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      const result = manager.delete('op-1');

      expect(result).toBe(true);
      expect(manager.has('op-1')).toBe(false);
    });

    it('should return false for unknown operation', () => {
      expect(manager.delete('nonexistent')).toBe(false);
    });

    it('clear should be an alias for delete', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      const result = manager.clear('op-1');

      expect(result).toBe(true);
      expect(manager.has('op-1')).toBe(false);
    });
  });

  describe('has / hasCheckpoint', () => {
    it('should return true for existing checkpoint', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      expect(manager.has('op-1')).toBe(true);
    });

    it('should return false for missing checkpoint', () => {
      expect(manager.has('nonexistent')).toBe(false);
    });

    it('should return false for expired checkpoint', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(manager.has('op-1')).toBe(false);
    });

    it('hasCheckpoint should be an alias for has', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      expect(manager.hasCheckpoint('op-1')).toBe(true);
      expect(manager.hasCheckpoint('nonexistent')).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should remove expired checkpoints', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      manager.save('op-2', createCheckpoint('op-2'));

      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      const removed = manager.cleanup();
      expect(removed).toBe(2);
      expect(manager.list()).toHaveLength(0);
    });

    it('should not remove non-expired checkpoints', () => {
      manager.save('op-1', createCheckpoint('op-1'));

      vi.advanceTimersByTime(1 * 60 * 60 * 1000); // 1h

      const removed = manager.cleanup();
      expect(removed).toBe(0);
      expect(manager.list()).toHaveLength(1);
    });

    it('should emit expired event for each cleaned checkpoint', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      const listener = vi.fn();
      manager.onEvent(listener);

      manager.cleanup();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'expired', operationId: 'op-1' }),
      );
    });
  });

  describe('clearAll', () => {
    it('should remove all checkpoints', () => {
      manager.save('op-1', createCheckpoint('op-1'));
      manager.save('op-2', createCheckpoint('op-2'));

      const count = manager.clearAll();
      expect(count).toBe(2);
      expect(manager.list()).toHaveLength(0);
    });
  });

  describe('custom retention', () => {
    it('should respect custom retention period', () => {
      const shortRetention = new CheckpointManager(store, 60_000); // 1 minute
      shortRetention.save('op-1', createCheckpoint('op-1'));

      vi.advanceTimersByTime(61_000);

      expect(shortRetention.restore('op-1')).toBeNull();
      shortRetention.dispose();
    });
  });

  describe('auto-save', () => {
    it('should start auto-save and save immediately', () => {
      const stateProvider = vi.fn().mockReturnValue(createCheckpoint('op-1'));
      manager.startAutoSave('op-1', stateProvider);

      expect(stateProvider).toHaveBeenCalledTimes(1);
      expect(manager.has('op-1')).toBe(true);
    });

    it('should save at regular intervals', () => {
      let processedRecords = 0;
      const stateProvider = vi
        .fn()
        .mockImplementation(() =>
          createCheckpoint('op-1', { processedRecords: ++processedRecords }),
        );

      manager.startAutoSave('op-1', stateProvider, 10_000);

      // Initial save
      expect(stateProvider).toHaveBeenCalledTimes(1);

      // After 10s
      vi.advanceTimersByTime(10_000);
      expect(stateProvider).toHaveBeenCalledTimes(2);

      // After 20s
      vi.advanceTimersByTime(10_000);
      expect(stateProvider).toHaveBeenCalledTimes(3);

      const restored = manager.restore('op-1');
      expect(restored?.processedRecords).toBe(3);
    });

    it('should use default 30s interval', () => {
      const stateProvider = vi.fn().mockReturnValue(createCheckpoint('op-1'));
      manager.startAutoSave('op-1', stateProvider);

      vi.advanceTimersByTime(30_000);
      expect(stateProvider).toHaveBeenCalledTimes(2); // initial + 1 interval
    });

    it('should stop auto-save', () => {
      const stateProvider = vi.fn().mockReturnValue(createCheckpoint('op-1'));
      manager.startAutoSave('op-1', stateProvider, 10_000);

      manager.stopAutoSave('op-1');

      vi.advanceTimersByTime(30_000);
      expect(stateProvider).toHaveBeenCalledTimes(1); // only initial
    });

    it('should report auto-save active status', () => {
      const stateProvider = vi.fn().mockReturnValue(createCheckpoint('op-1'));

      expect(manager.isAutoSaveActive('op-1')).toBe(false);

      manager.startAutoSave('op-1', stateProvider);
      expect(manager.isAutoSaveActive('op-1')).toBe(true);

      manager.stopAutoSave('op-1');
      expect(manager.isAutoSaveActive('op-1')).toBe(false);
    });

    it('should cancel previous auto-save when starting a new one', () => {
      const provider1 = vi.fn().mockReturnValue(createCheckpoint('op-1', { processedRecords: 10 }));
      const provider2 = vi.fn().mockReturnValue(createCheckpoint('op-1', { processedRecords: 99 }));

      manager.startAutoSave('op-1', provider1, 10_000);
      manager.startAutoSave('op-1', provider2, 10_000);

      vi.advanceTimersByTime(10_000);

      // Only provider2 should continue
      expect(provider2).toHaveBeenCalledTimes(2); // initial + 1 interval
      const restored = manager.restore('op-1');
      expect(restored?.processedRecords).toBe(99);
    });
  });

  describe('getRecoverableCheckpoints', () => {
    it('should return only in_progress checkpoints', () => {
      manager.save('op-1', createCheckpoint('op-1', { status: 'in_progress' }));
      manager.save('op-2', createCheckpoint('op-2', { status: 'completed' }));
      manager.save('op-3', createCheckpoint('op-3', { status: 'failed' }));
      manager.save('op-4', createCheckpoint('op-4', { status: 'in_progress' }));

      const recoverable = manager.getRecoverableCheckpoints();
      expect(recoverable).toHaveLength(2);
      expect(recoverable.map((cp) => cp.operationId)).toEqual(
        expect.arrayContaining(['op-1', 'op-4']),
      );
    });

    it('should exclude expired checkpoints', () => {
      manager.save('op-1', createCheckpoint('op-1', { status: 'in_progress' }));
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(manager.getRecoverableCheckpoints()).toHaveLength(0);
    });

    it('should return empty array when no recoverable checkpoints', () => {
      expect(manager.getRecoverableCheckpoints()).toEqual([]);
    });
  });

  describe('events', () => {
    it('should register and unregister listeners', () => {
      const listener: CheckpointEventListener = vi.fn();

      manager.onEvent(listener);
      manager.save('op-1', createCheckpoint('op-1'));
      expect(listener).toHaveBeenCalledTimes(1);

      manager.offEvent(listener);
      manager.save('op-2', createCheckpoint('op-2'));
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });

    it('should notify multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      manager.onEvent(listener1);
      manager.onEvent(listener2);
      manager.save('op-1', createCheckpoint('op-1'));

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe('dispose', () => {
    it('should stop all auto-save timers', () => {
      const provider = vi.fn().mockReturnValue(createCheckpoint('op-1'));
      manager.startAutoSave('op-1', provider, 10_000);

      manager.dispose();

      vi.advanceTimersByTime(30_000);
      expect(provider).toHaveBeenCalledTimes(1); // only initial
    });

    it('should clear all listeners', () => {
      const listener = vi.fn();
      manager.onEvent(listener);

      manager.dispose();
      manager.save('op-1', createCheckpoint('op-1'));

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
