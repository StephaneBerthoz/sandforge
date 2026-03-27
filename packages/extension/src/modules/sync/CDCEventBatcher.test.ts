import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CDCEventBatcher } from './CDCEventBatcher';
import type { CDCEvent } from '@sandforge/shared';

function createEvent(replayId: number): CDCEvent {
  return {
    replayId,
    objectApiName: 'Account',
    changeType: 'UPDATE',
    recordIds: ['001xx0000001234'],
    changedFields: { Name: 'Test' },
    commitTimestamp: new Date().toISOString(),
    commitUser: '005xx0000001111',
    transactionKey: `txn-${replayId}`,
  };
}

describe('CDCEventBatcher', () => {
  let postFn: ReturnType<typeof vi.fn>;
  let batcher: CDCEventBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    postFn = vi.fn();
    batcher = new CDCEventBatcher(postFn, 150);
  });

  afterEach(() => {
    batcher.dispose();
    vi.useRealTimers();
  });

  describe('batching', () => {
    it('should not call postFn immediately when events are pushed', () => {
      batcher.push(createEvent(1));
      batcher.push(createEvent(2));

      expect(postFn).not.toHaveBeenCalled();
    });

    it('should batch events within the window and flush together', () => {
      batcher.push(createEvent(1));
      batcher.push(createEvent(2));
      batcher.push(createEvent(3));

      vi.advanceTimersByTime(150);

      expect(postFn).toHaveBeenCalledTimes(1);
      expect(postFn).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ replayId: 1 }),
          expect.objectContaining({ replayId: 2 }),
          expect.objectContaining({ replayId: 3 }),
        ]),
      );
    });

    it('should deliver events in insertion order', () => {
      batcher.push(createEvent(10));
      batcher.push(createEvent(20));
      batcher.push(createEvent(30));

      vi.advanceTimersByTime(150);

      const batch = postFn.mock.calls[0][0] as CDCEvent[];
      expect(batch.map((e) => e.replayId)).toEqual([10, 20, 30]);
    });

    it('should start a new batch window after flush', () => {
      batcher.push(createEvent(1));
      vi.advanceTimersByTime(150);

      expect(postFn).toHaveBeenCalledTimes(1);

      batcher.push(createEvent(2));
      vi.advanceTimersByTime(150);

      expect(postFn).toHaveBeenCalledTimes(2);
      expect(postFn).toHaveBeenLastCalledWith(
        expect.arrayContaining([expect.objectContaining({ replayId: 2 })]),
      );
    });

    it('should not flush when buffer is empty', () => {
      batcher.flush();

      expect(postFn).not.toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('should flush remaining events on manual flush call', () => {
      batcher.push(createEvent(1));
      batcher.push(createEvent(2));

      batcher.flush();

      expect(postFn).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ replayId: 1 }),
          expect.objectContaining({ replayId: 2 }),
        ]),
      );
    });

    it('should clear buffer after flush', () => {
      batcher.push(createEvent(1));
      batcher.flush();

      expect(batcher.getBufferedCount()).toBe(0);
    });
  });

  describe('dispose', () => {
    it('should flush remaining events on dispose', () => {
      batcher.push(createEvent(1));
      batcher.push(createEvent(2));

      batcher.dispose();

      expect(postFn).toHaveBeenCalledTimes(1);
      expect(postFn).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ replayId: 1 }),
          expect.objectContaining({ replayId: 2 }),
        ]),
      );
    });
  });

  describe('ring buffer overflow', () => {
    it('should drop oldest events when capacity is exceeded', () => {
      const smallBatcher = new CDCEventBatcher(postFn, 150, 3);

      smallBatcher.push(createEvent(1));
      smallBatcher.push(createEvent(2));
      smallBatcher.push(createEvent(3));
      smallBatcher.push(createEvent(4)); // Overwrites event 1

      smallBatcher.flush();

      const batch = postFn.mock.calls[0][0] as CDCEvent[];
      expect(batch).toHaveLength(3);
      // Oldest event (1) should be dropped, events 2, 3, 4 remain
      expect(batch.map((e) => e.replayId)).toEqual([2, 3, 4]);
    });

    it('should report correct buffered count at capacity', () => {
      const smallBatcher = new CDCEventBatcher(postFn, 150, 3);

      smallBatcher.push(createEvent(1));
      smallBatcher.push(createEvent(2));
      smallBatcher.push(createEvent(3));
      smallBatcher.push(createEvent(4));
      smallBatcher.push(createEvent(5));

      // Count should be capped at capacity
      expect(smallBatcher.getBufferedCount()).toBe(3);

      smallBatcher.dispose();
    });
  });

  describe('buffered count', () => {
    it('should track buffered event count', () => {
      expect(batcher.getBufferedCount()).toBe(0);

      batcher.push(createEvent(1));
      expect(batcher.getBufferedCount()).toBe(1);

      batcher.push(createEvent(2));
      expect(batcher.getBufferedCount()).toBe(2);
    });
  });
});
