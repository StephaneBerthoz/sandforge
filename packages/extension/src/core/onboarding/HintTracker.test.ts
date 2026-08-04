import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HintTracker } from './HintTracker';

describe('HintTracker', () => {
  let tracker: HintTracker;
  let store: Map<string, string>;
  const mockUpdate = vi.fn<[key: string, value: string], Promise<void>>();

  beforeEach(() => {
    store = new Map();
    mockUpdate.mockClear();
    mockUpdate.mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    });
    tracker = new HintTracker({
      get: (key: string) => store.get(key),
      update: mockUpdate,
    });
  });

  describe('isHintSeen', () => {
    it('should return false for a hint that has never been seen', () => {
      expect(tracker.isHintSeen('welcome-tip')).toBe(false);
    });

    it('should return true after the hint is marked as seen', async () => {
      await tracker.markHintSeen('welcome-tip');
      expect(tracker.isHintSeen('welcome-tip')).toBe(true);
    });

    it('should use the correct key prefix', async () => {
      await tracker.markHintSeen('my-hint');
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.hint.my-hint', 'true');
    });
  });

  describe('markHintSeen', () => {
    it('should persist the seen state with the prefixed key', async () => {
      await tracker.markHintSeen('connect-org');
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.hint.connect-org', 'true');
    });

    it('should not affect other hints', async () => {
      await tracker.markHintSeen('hint-a');
      expect(tracker.isHintSeen('hint-a')).toBe(true);
      expect(tracker.isHintSeen('hint-b')).toBe(false);
    });
  });

  describe('resetAllHints', () => {
    it('should clear all specified hints', async () => {
      await tracker.markHintSeen('hint-1');
      await tracker.markHintSeen('hint-2');
      await tracker.resetAllHints(['hint-1', 'hint-2']);
      expect(tracker.isHintSeen('hint-1')).toBe(false);
      expect(tracker.isHintSeen('hint-2')).toBe(false);
    });

    it('should call update for each hint id', async () => {
      await tracker.resetAllHints(['a', 'b', 'c']);
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.hint.a', '');
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.hint.b', '');
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.hint.c', '');
    });

    it('should handle an empty array without errors', async () => {
      await tracker.resetAllHints([]);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
