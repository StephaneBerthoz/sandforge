import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVisibilityGate } from './useVisibilityGate';

const sendSpy = vi.fn();

vi.mock('./useMessageBus', () => ({
  useSendMessage: () => sendSpy,
}));

describe('useVisibilityGate', () => {
  beforeEach(() => {
    sendSpy.mockReset();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
  });

  afterEach(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
  });

  it('on mount posts a monitor:visibility message with hidden: false', () => {
    renderHook(() => useVisibilityGate());
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      type: 'monitor:visibility',
      payload: { hidden: false },
    });
  });

  it('posts hidden: true after visibilitychange when document.hidden = true', () => {
    renderHook(() => useVisibilityGate());
    sendSpy.mockClear();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      type: 'monitor:visibility',
      payload: { hidden: true },
    });
  });

  it('unmount removes the listener — no further posts on visibility changes', () => {
    const { unmount } = renderHook(() => useVisibilityGate());
    sendSpy.mockClear();
    unmount();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
