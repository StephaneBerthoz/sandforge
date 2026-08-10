import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ---------- Mock setup ---------- */

let mockState: Record<string, unknown> | undefined;

vi.mock('../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => mockState,
    setState: (newState: unknown) => {
      mockState = newState as Record<string, unknown>;
    },
  }),
}));

import { getPersistedItem, setPersistedItem, removePersistedItem } from './webviewStorage';

/* ---------- Tests ---------- */

describe('webviewStorage', () => {
  beforeEach(() => {
    mockState = undefined;
  });

  describe('getPersistedItem', () => {
    it('returns null when no state exists', () => {
      expect(getPersistedItem('missing')).toBeNull();
    });

    it('returns null when the key is absent', () => {
      mockState = { other: 'value' };
      expect(getPersistedItem('missing')).toBeNull();
    });

    it('returns the persisted string value', () => {
      mockState = { myKey: 'saved' };
      expect(getPersistedItem('myKey')).toBe('saved');
    });

    it('returns null for non-string values', () => {
      mockState = { myKey: 42 };
      expect(getPersistedItem('myKey')).toBeNull();
    });
  });

  describe('setPersistedItem', () => {
    it('writes the value into the webview state', () => {
      setPersistedItem('myKey', 'hello');
      expect(mockState?.myKey).toBe('hello');
    });

    it('merges with existing state keys', () => {
      mockState = { otherKey: 'keepMe' };
      setPersistedItem('myKey', 'world');
      expect(mockState?.otherKey).toBe('keepMe');
      expect(mockState?.myKey).toBe('world');
    });

    it('overwrites an existing value for the same key', () => {
      mockState = { myKey: 'old' };
      setPersistedItem('myKey', 'new');
      expect(mockState?.myKey).toBe('new');
    });
  });

  describe('removePersistedItem', () => {
    it('removes only the target key', () => {
      mockState = { myKey: 'bye', otherKey: 'stay' };
      removePersistedItem('myKey');
      expect(mockState?.myKey).toBeUndefined();
      expect(mockState?.otherKey).toBe('stay');
    });

    it('is a no-op when the key is absent', () => {
      mockState = { otherKey: 'stay' };
      removePersistedItem('missing');
      expect(mockState).toEqual({ otherKey: 'stay' });
    });
  });
});
