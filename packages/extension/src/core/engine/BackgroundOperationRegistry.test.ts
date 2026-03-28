import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundOperationRegistry } from './BackgroundOperationRegistry';
import type { OperationEventType } from './BackgroundOperationRegistry';

describe('BackgroundOperationRegistry', () => {
  let registry: BackgroundOperationRegistry;

  beforeEach(() => {
    registry = new BackgroundOperationRegistry();
  });

  describe('register', () => {
    it('should store operation and emit started event', () => {
      const listener = vi.fn();
      registry.onEvent(listener);

      const abortController = new AbortController();
      const promise = new Promise<void>(() => {
        // never resolves
      });

      const op = registry.register('op-1', 'sync', 'Sync Account', promise, abortController);

      expect(op.operationId).toBe('op-1');
      expect(op.module).toBe('sync');
      expect(op.description).toBe('Sync Account');
      expect(op.status).toBe('running');
      expect(op.progressPercent).toBe(0);
      expect(op.startedAt).toBeGreaterThan(0);
      expect(op.notifiedNatively).toBe(false);
      expect(registry.has('op-1')).toBe(true);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith('op-1', 'started', op);
    });
  });

  describe('promise resolution triggers markCompleted', () => {
    it('should mark operation as completed and emit event on promise resolve', async () => {
      const events: { id: string; type: OperationEventType }[] = [];
      registry.onEvent((id, type) => {
        events.push({ id, type });
      });

      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });

      registry.register('op-1', 'seed', 'Seed Contact', promise, new AbortController());

      resolve();
      await promise;
      // Allow microtask to complete the .then() handler
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });

      const op = registry.get('op-1');
      expect(op?.status).toBe('completed');
      expect(op?.progressPercent).toBe(100);
      expect(op?.completedAt).toBeGreaterThan(0);

      expect(events).toEqual([
        { id: 'op-1', type: 'started' },
        { id: 'op-1', type: 'completed' },
      ]);
    });
  });

  describe('promise rejection triggers markFailed', () => {
    it('should mark operation as failed and emit event on promise reject', async () => {
      const events: { id: string; type: OperationEventType }[] = [];
      registry.onEvent((id, type) => {
        events.push({ id, type });
      });

      let reject!: (err: Error) => void;
      const promise = new Promise<void>((_r, rej) => {
        reject = rej;
      });

      registry.register('op-1', 'clone', 'Clone Account', promise, new AbortController());

      reject(new Error('SOQL limit exceeded'));
      try {
        await promise;
      } catch {
        // expected
      }
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });

      const op = registry.get('op-1');
      expect(op?.status).toBe('failed');
      expect(op?.completedAt).toBeGreaterThan(0);
      expect(op?.resultSummary).toBe('SOQL limit exceeded');

      expect(events).toEqual([
        { id: 'op-1', type: 'started' },
        { id: 'op-1', type: 'failed' },
      ]);
    });
  });

  describe('abort', () => {
    it('should call abortController.abort() and emit aborted event', () => {
      const listener = vi.fn();
      registry.onEvent(listener);

      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');
      const promise = new Promise<void>(() => {
        // never resolves
      });

      registry.register('op-1', 'sync', 'Sync Lead', promise, abortController);
      listener.mockClear();

      registry.abort('op-1');

      expect(abortSpy).toHaveBeenCalledOnce();
      const op = registry.get('op-1');
      expect(op?.status).toBe('aborted');
      expect(op?.completedAt).toBeGreaterThan(0);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith('op-1', 'aborted', op);
    });

    it('should do nothing for a non-existent operation', () => {
      expect(() => registry.abort('nonexistent')).not.toThrow();
    });
  });

  describe('updateProgress', () => {
    it('should update percent and emit progress event', () => {
      const listener = vi.fn();
      registry.onEvent(listener);

      const promise = new Promise<void>(() => {
        // never resolves
      });
      registry.register('op-1', 'seed', 'Seed Account', promise, new AbortController());
      listener.mockClear();

      registry.updateProgress('op-1', 42, '4,200 records processed');

      const op = registry.get('op-1');
      expect(op?.progressPercent).toBe(42);
      expect(op?.resultSummary).toBe('4,200 records processed');

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith('op-1', 'progress', op);
    });

    it('should do nothing for a non-existent operation', () => {
      expect(() => registry.updateProgress('nonexistent', 50)).not.toThrow();
    });

    it('should not overwrite resultSummary when summary is omitted', () => {
      const promise = new Promise<void>(() => {
        // never resolves
      });
      registry.register('op-1', 'seed', 'Seed', promise, new AbortController());
      registry.updateProgress('op-1', 50, 'halfway');
      registry.updateProgress('op-1', 75);

      expect(registry.get('op-1')?.resultSummary).toBe('halfway');
    });
  });

  describe('getActiveOperations', () => {
    it('should return all ops as ActiveOperation shape sorted by startedAt desc', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-03-28T10:00:00Z'));
        const p1 = new Promise<void>(() => {
          // never resolves
        });
        const p2 = new Promise<void>(() => {
          // never resolves
        });

        registry.register('op-1', 'sync', 'Sync Account', p1, new AbortController());
        vi.setSystemTime(new Date('2026-03-28T10:01:00Z'));
        registry.register('op-2', 'seed', 'Seed Contact', p2, new AbortController());

        const ops = registry.getActiveOperations();

        expect(ops).toHaveLength(2);
        // Newest first
        expect(ops[0].operationId).toBe('op-2');
        expect(ops[1].operationId).toBe('op-1');

        // Shape check: no abortController or notifiedNatively
        for (const op of ops) {
          expect(op).toHaveProperty('operationId');
          expect(op).toHaveProperty('module');
          expect(op).toHaveProperty('description');
          expect(op).toHaveProperty('status');
          expect(op).toHaveProperty('progressPercent');
          expect(op).toHaveProperty('startedAt');
          expect(op).not.toHaveProperty('abortController');
          expect(op).not.toHaveProperty('notifiedNatively');
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getRunning', () => {
    it('should return only running operations', async () => {
      let resolve!: () => void;
      const p1 = new Promise<void>((r) => {
        resolve = r;
      });
      const p2 = new Promise<void>(() => {
        // never resolves
      });

      registry.register('op-1', 'sync', 'Sync', p1, new AbortController());
      registry.register('op-2', 'seed', 'Seed', p2, new AbortController());

      resolve();
      await p1;
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });

      const running = registry.getRunning();
      expect(running).toHaveLength(1);
      expect(running[0].operationId).toBe('op-2');
    });
  });

  describe('eviction of oldest completed', () => {
    it('should evict oldest completed when exceeding maxCompleted', async () => {
      // Register and complete 51 operations to trigger eviction
      const promises: Promise<void>[] = [];
      const resolvers: (() => void)[] = [];

      for (let i = 0; i < 51; i++) {
        let resolve!: () => void;
        const p = new Promise<void>((r) => {
          resolve = r;
        });
        promises.push(p);
        resolvers.push(resolve);
        registry.register(`op-${i}`, 'sync', `Op ${i}`, p, new AbortController());
      }

      // Complete all
      for (const resolve of resolvers) {
        resolve();
      }
      await Promise.all(promises);
      await new Promise<void>((r) => {
        setTimeout(r, 10);
      });

      const ops = registry.getActiveOperations();
      // Should have evicted oldest, max 50
      expect(ops.length).toBeLessThanOrEqual(50);
      // The first operation (op-0) should have been evicted
      expect(registry.has('op-0')).toBe(false);
    });
  });

  describe('markNotifiedNatively', () => {
    it('should set notifiedNatively flag', () => {
      const promise = new Promise<void>(() => {
        // never resolves
      });
      registry.register('op-1', 'sync', 'Sync', promise, new AbortController());

      registry.markNotifiedNatively('op-1');

      expect(registry.get('op-1')?.notifiedNatively).toBe(true);
    });

    it('should do nothing for a non-existent operation', () => {
      expect(() => registry.markNotifiedNatively('nonexistent')).not.toThrow();
    });
  });

  describe('onEvent', () => {
    it('should return an unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = registry.onEvent(listener);

      const promise = new Promise<void>(() => {
        // never resolves
      });
      registry.register('op-1', 'sync', 'Sync', promise, new AbortController());
      expect(listener).toHaveBeenCalledOnce();

      unsub();

      registry.register('op-2', 'seed', 'Seed', promise, new AbortController());
      // Should not have been called again after unsubscribe
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe('dispose', () => {
    it('should clear all operations and listeners', () => {
      const listener = vi.fn();
      registry.onEvent(listener);

      const promise = new Promise<void>(() => {
        // never resolves
      });
      registry.register('op-1', 'sync', 'Sync', promise, new AbortController());
      listener.mockClear();

      registry.dispose();

      expect(registry.has('op-1')).toBe(false);
      expect(registry.getActiveOperations()).toEqual([]);

      // Listener should not fire after dispose
      registry.register('op-2', 'seed', 'Seed', promise, new AbortController());
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('has and get', () => {
    it('should return true/operation for existing ops', () => {
      const promise = new Promise<void>(() => {
        // never resolves
      });
      registry.register('op-1', 'sync', 'Sync', promise, new AbortController());

      expect(registry.has('op-1')).toBe(true);
      expect(registry.get('op-1')?.operationId).toBe('op-1');
    });

    it('should return false/undefined for non-existent ops', () => {
      expect(registry.has('nope')).toBe(false);
      expect(registry.get('nope')).toBeUndefined();
    });
  });

  describe('markFailed with non-Error values', () => {
    it('should handle string errors', async () => {
      let reject!: (err: unknown) => void;
      const promise = new Promise<void>((_r, rej) => {
        reject = rej;
      });

      registry.register('op-1', 'sync', 'Sync', promise, new AbortController());

      reject('string error');
      try {
        await promise;
      } catch {
        // expected
      }
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });

      expect(registry.get('op-1')?.resultSummary).toBe('string error');
    });
  });

  describe('markCompleted ignores already-finished operations', () => {
    it('should not re-emit completed for an aborted operation', async () => {
      const events: OperationEventType[] = [];
      registry.onEvent((_id, type) => {
        events.push(type);
      });

      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });

      registry.register('op-1', 'sync', 'Sync', promise, new AbortController());
      registry.abort('op-1');

      // Now resolve the promise - markCompleted should be a no-op
      resolve();
      await promise;
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });

      expect(events).toEqual(['started', 'aborted']);
      expect(registry.get('op-1')?.status).toBe('aborted');
    });
  });
});
