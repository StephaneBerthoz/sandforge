import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/* ---------- Mock setup ---------- */

let mockState: Record<string, unknown> = {};

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => (Object.keys(mockState).length > 0 ? mockState : undefined),
    setState: (newState: unknown) => {
      mockState = newState as Record<string, unknown>;
    },
  }),
}));

import { useWebviewPersistedState } from './useWebviewPersistedState';

/* ---------- Tests ---------- */

describe('useWebviewPersistedState', () => {
  beforeEach(() => {
    mockState = {};
  });

  it('should use initialValue when no persisted state exists', () => {
    const { result } = renderHook(() => useWebviewPersistedState('myKey', 42));
    expect(result.current[0]).toBe(42);
  });

  it('should restore persisted value on mount', () => {
    mockState = { myKey: 'savedValue' };
    const { result } = renderHook(() => useWebviewPersistedState('myKey', 'default'));
    expect(result.current[0]).toBe('savedValue');
  });

  it('should update both React state and vscode state when setValue is called', () => {
    const { result } = renderHook(() => useWebviewPersistedState('testKey', 'initial'));

    act(() => {
      result.current[1]('updated');
    });

    expect(result.current[0]).toBe('updated');
    expect(mockState.testKey).toBe('updated');
  });

  it('should not interfere with other keys in persisted state', () => {
    mockState = { otherKey: 'keepMe' };
    const { result } = renderHook(() => useWebviewPersistedState('myKey', 'hello'));

    act(() => {
      result.current[1]('world');
    });

    expect(mockState.otherKey).toBe('keepMe');
    expect(mockState.myKey).toBe('world');
  });

  it('should handle undefined/null getState() return gracefully', () => {
    mockState = {};
    const { result } = renderHook(() => useWebviewPersistedState('key', { count: 0 }));
    expect(result.current[0]).toEqual({ count: 0 });
  });

  it('should persist complex objects', () => {
    const complex = { step: 2, items: ['a', 'b'], nested: { flag: true } };
    const { result } = renderHook(() =>
      useWebviewPersistedState('draft', {
        step: 0,
        items: [] as string[],
        nested: { flag: false },
      }),
    );

    act(() => {
      result.current[1](complex);
    });

    expect(result.current[0]).toEqual(complex);
    expect(mockState.draft).toEqual(complex);
  });

  it('should allow multiple independent keys', () => {
    const { result: resultA } = renderHook(() => useWebviewPersistedState('keyA', 1));
    const { result: resultB } = renderHook(() => useWebviewPersistedState('keyB', 2));

    act(() => {
      resultA.current[1](10);
    });
    act(() => {
      resultB.current[1](20);
    });

    expect(mockState.keyA).toBe(10);
    expect(mockState.keyB).toBe(20);
  });
});
