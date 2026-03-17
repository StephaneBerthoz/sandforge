import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

describe('useVSCodeApi', () => {
  const mockPostMessage = vi.fn();
  const mockGetState = vi.fn();
  const mockSetState = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockPostMessage.mockClear();
    mockGetState.mockClear();
    mockSetState.mockClear();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).acquireVsCodeApi;
  });

  it('should return the VSCode API when acquireVsCodeApi is available', async () => {
    (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
      postMessage: mockPostMessage,
      getState: mockGetState,
      setState: mockSetState,
    });

    const { useVSCodeApi } = await import('./useVSCodeApi');
    const { result } = renderHook(() => useVSCodeApi());

    expect(result.current.postMessage).toBe(mockPostMessage);
    expect(result.current.getState).toBe(mockGetState);
    expect(result.current.setState).toBe(mockSetState);
  });

  it('should return a no-op fallback when acquireVsCodeApi is not defined', async () => {
    const { useVSCodeApi } = await import('./useVSCodeApi');
    const { result } = renderHook(() => useVSCodeApi());

    expect(result.current.postMessage('test')).toBeUndefined();
    expect(result.current.getState()).toBeUndefined();
    expect(result.current.setState('state')).toBeUndefined();
  });

  it('should cache the API instance across multiple calls', async () => {
    let callCount = 0;
    (globalThis as Record<string, unknown>).acquireVsCodeApi = () => {
      callCount++;
      return {
        postMessage: mockPostMessage,
        getState: mockGetState,
        setState: mockSetState,
      };
    };

    const { useVSCodeApi } = await import('./useVSCodeApi');
    const { result: result1 } = renderHook(() => useVSCodeApi());
    const { result: result2 } = renderHook(() => useVSCodeApi());

    expect(result1.current).toBe(result2.current);
    expect(callCount).toBe(1);
  });

  it('should allow postMessage to be called with a message', async () => {
    (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
      postMessage: mockPostMessage,
      getState: mockGetState,
      setState: mockSetState,
    });

    const { useVSCodeApi } = await import('./useVSCodeApi');
    const { result } = renderHook(() => useVSCodeApi());

    result.current.postMessage({ type: 'test', id: '1', timestamp: Date.now() });

    expect(mockPostMessage).toHaveBeenCalledOnce();
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'test', id: '1' }),
    );
  });
});
