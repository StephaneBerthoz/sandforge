import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { BaseMessage } from '@sandforge/shared';

/**
 * Mock the useVSCodeApi hook so tests do not depend on acquireVsCodeApi.
 */
const mockPostMessage = vi.fn();

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import { useSendMessage, useMessageListener } from './useMessageBus';

describe('useSendMessage', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('should return a function', () => {
    const { result } = renderHook(() => useSendMessage());
    expect(typeof result.current).toBe('function');
  });

  it('should call postMessage with the provided message', () => {
    const { result } = renderHook(() => useSendMessage());

    const message: BaseMessage = {
      id: 'msg-1',
      type: 'org:list',
      timestamp: Date.now(),
    };

    result.current(message);

    expect(mockPostMessage).toHaveBeenCalledOnce();
    expect(mockPostMessage).toHaveBeenCalledWith(message);
  });
});

describe('useMessageListener', () => {
  let addEventSpy: ReturnType<typeof vi.spyOn>;
  let removeEventSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventSpy = vi.spyOn(window, 'addEventListener');
    removeEventSpy = vi.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    addEventSpy.mockRestore();
    removeEventSpy.mockRestore();
  });

  it('should add and remove a message event listener', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useMessageListener('test:type', handler));

    expect(addEventSpy).toHaveBeenCalledWith('message', expect.any(Function));

    unmount();

    expect(removeEventSpy).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('should call the handler when a matching message arrives', () => {
    const handler = vi.fn();
    renderHook(() => useMessageListener('org:list:response', handler));

    const message: BaseMessage = {
      id: 'resp-1',
      type: 'org:list:response',
      timestamp: Date.now(),
    };

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: message }));
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(message);
  });

  it('should not call the handler for non-matching message types', () => {
    const handler = vi.fn();
    renderHook(() => useMessageListener('org:list:response', handler));

    const message: BaseMessage = {
      id: 'other-1',
      type: 'settings:response',
      timestamp: Date.now(),
    };

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: message }));
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should not call the handler for events with no data', () => {
    const handler = vi.fn();
    renderHook(() => useMessageListener('org:list', handler));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: undefined }));
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should always invoke the latest handler reference', () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const { rerender } = renderHook(
      ({ handler }) => useMessageListener('test:type', handler),
      { initialProps: { handler: firstHandler } },
    );

    rerender({ handler: secondHandler });

    const message: BaseMessage = {
      id: 'msg-2',
      type: 'test:type',
      timestamp: Date.now(),
    };

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: message }));
    });

    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledOnce();
  });
});
