import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from './QueueManager';
import type { QueuedOperation } from './QueueManager';

function createOperation(id: string, name: string = 'Test Op'): QueuedOperation {
  return {
    id,
    name,
    status: 'queued',
    priority: 5,
    createdAt: '2026-02-20T00:00:00.000Z',
  };
}

describe('QueueManager', () => {
  let manager: QueueManager;

  beforeEach(() => {
    manager = new QueueManager(10);
  });

  describe('enqueue', () => {
    it('should add an operation to the queue', () => {
      manager.enqueue(createOperation('op-1'));
      expect(manager.size).toBe(1);
    });

    it('should return the operation ID', () => {
      const id = manager.enqueue(createOperation('op-1'));
      expect(id).toBe('op-1');
    });

    it('should throw when queue is full', () => {
      const small = new QueueManager(2);
      small.enqueue(createOperation('op-1'));
      small.enqueue(createOperation('op-2'));

      expect(() => small.enqueue(createOperation('op-3'))).toThrow('Queue is full');
    });

    it('should clamp priority between 0 and 10', () => {
      manager.enqueue(createOperation('op-1'), -5);
      manager.enqueue(createOperation('op-2'), 15);

      const first = manager.dequeue();
      expect(first?.id).toBe('op-1'); // priority 0 (clamped from -5)
    });
  });

  describe('dequeue', () => {
    it('should return the highest-priority operation', () => {
      manager.enqueue(createOperation('op-low'), 8);
      manager.enqueue(createOperation('op-high'), 1);
      manager.enqueue(createOperation('op-mid'), 5);

      const op = manager.dequeue();
      expect(op?.id).toBe('op-high');
      expect(op?.status).toBe('processing');
    });

    it('should return null when queue is empty', () => {
      expect(manager.dequeue()).toBeNull();
    });

    it('should maintain FIFO order for same priority', () => {
      manager.enqueue(createOperation('op-1'), 5);
      manager.enqueue(createOperation('op-2'), 5);
      manager.enqueue(createOperation('op-3'), 5);

      expect(manager.dequeue()?.id).toBe('op-1');
      expect(manager.dequeue()?.id).toBe('op-2');
      expect(manager.dequeue()?.id).toBe('op-3');
    });

    it('should remove the operation from the queue', () => {
      manager.enqueue(createOperation('op-1'));
      manager.dequeue();

      expect(manager.size).toBe(0);
    });
  });

  describe('peek', () => {
    it('should return the highest-priority operation without removing it', () => {
      manager.enqueue(createOperation('op-1'), 3);
      manager.enqueue(createOperation('op-2'), 1);

      const op = manager.peek();
      expect(op?.id).toBe('op-2');
      expect(manager.size).toBe(2);
    });

    it('should return null when queue is empty', () => {
      expect(manager.peek()).toBeNull();
    });
  });

  describe('cancel', () => {
    it('should cancel a queued operation', () => {
      manager.enqueue(createOperation('op-1'));
      const result = manager.cancel('op-1');

      expect(result).toBe(true);
      expect(manager.size).toBe(0);
    });

    it('should return false for unknown operation', () => {
      expect(manager.cancel('nonexistent')).toBe(false);
    });

    it('should track cancelled operations in status', () => {
      manager.enqueue(createOperation('op-1'));
      manager.cancel('op-1');

      const status = manager.getStatus();
      expect(status.totalCancelled).toBe(1);
    });
  });

  describe('getStatus', () => {
    it('should return correct queue status', () => {
      manager.enqueue(createOperation('op-1'));
      manager.enqueue(createOperation('op-2'));
      manager.cancel('op-1');
      manager.markCompleted('op-3');
      manager.markFailed('op-4');

      const status = manager.getStatus();
      expect(status.totalQueued).toBe(1);
      expect(status.totalCompleted).toBe(1);
      expect(status.totalFailed).toBe(1);
      expect(status.totalCancelled).toBe(1);
      expect(status.maxSize).toBe(10);
    });

    it('should return empty status for new queue', () => {
      const status = manager.getStatus();
      expect(status.totalQueued).toBe(0);
      expect(status.totalCompleted).toBe(0);
      expect(status.totalFailed).toBe(0);
      expect(status.totalCancelled).toBe(0);
    });
  });

  describe('isEmpty / isFull', () => {
    it('should report empty when no items', () => {
      expect(manager.isEmpty()).toBe(true);
    });

    it('should report not empty when items exist', () => {
      manager.enqueue(createOperation('op-1'));
      expect(manager.isEmpty()).toBe(false);
    });

    it('should report full when at capacity', () => {
      const small = new QueueManager(2);
      small.enqueue(createOperation('op-1'));
      small.enqueue(createOperation('op-2'));

      expect(small.isFull()).toBe(true);
    });

    it('should report not full when under capacity', () => {
      expect(manager.isFull()).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all queued operations', () => {
      manager.enqueue(createOperation('op-1'));
      manager.enqueue(createOperation('op-2'));
      manager.clear();

      expect(manager.size).toBe(0);
      expect(manager.isEmpty()).toBe(true);
    });
  });

  describe('clearHistory', () => {
    it('should clear completed/failed/cancelled history', () => {
      manager.markCompleted('op-1');
      manager.markFailed('op-2');
      manager.clearHistory();

      const status = manager.getStatus();
      expect(status.totalCompleted).toBe(0);
      expect(status.totalFailed).toBe(0);
    });
  });

  describe('default max size', () => {
    it('should default to 100', () => {
      const defaultManager = new QueueManager();
      const status = defaultManager.getStatus();
      expect(status.maxSize).toBe(100);
    });
  });

  describe('priority ordering', () => {
    it('should dequeue in priority order', () => {
      manager.enqueue(createOperation('op-low'), 10);
      manager.enqueue(createOperation('op-high'), 0);
      manager.enqueue(createOperation('op-mid'), 5);

      expect(manager.dequeue()?.id).toBe('op-high');
      expect(manager.dequeue()?.id).toBe('op-mid');
      expect(manager.dequeue()?.id).toBe('op-low');
    });
  });
});
