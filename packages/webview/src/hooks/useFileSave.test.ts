import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import '../i18n';
import { useNotificationStore } from '../stores/useNotificationStore';
import { useFileSave } from './useFileSave';

const mockPostMessage = vi.fn();
const api = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => api,
  getVscodeApi: () => api,
}));

/** Ask for a save and return the id of the file:save request it posted. */
function saveAndGetRequestId(result: { current: ReturnType<typeof useFileSave> }): string {
  act(() => {
    result.current.save('limits.csv', 'a,b\n1,2', ['csv']);
  });
  const envelope = mockPostMessage.mock.calls.at(-1)?.[0] as {
    payload: { id: string; type: string };
  };
  expect(envelope.payload.type).toBe('file:save');
  return envelope.payload.id;
}

/** Deliver the host's answer to a save. */
function answer(correlationId: string, payload: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'host-1',
          type: 'file:save:response',
          timestamp: Date.now(),
          correlationId,
          payload,
        },
      }),
    );
  });
}

describe('useFileSave', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useNotificationStore.setState({ notifications: [] });
  });

  it('says where the file was saved', () => {
    const { result } = renderHook(() => useFileSave());
    const id = saveAndGetRequestId(result);

    answer(id, { status: 'saved', path: '/home/user/limits.csv' });

    const [notification] = useNotificationStore.getState().notifications;
    expect(notification.level).toBe('success');
    expect(notification.message).toContain('/home/user/limits.csv');
    expect(result.current.saving).toBe(false);
  });

  it('says why a refused save was not written', () => {
    const { result } = renderHook(() => useFileSave());
    const id = saveAndGetRequestId(result);

    answer(id, { status: 'error', message: 'Invalid payload — content: too large' });

    const [notification] = useNotificationStore.getState().notifications;
    expect(notification.level).toBe('error');
    expect(notification.message).toBe('Invalid payload — content: too large');
  });

  it('says nothing when the dialog is dismissed', () => {
    const { result } = renderHook(() => useFileSave());
    const id = saveAndGetRequestId(result);

    answer(id, { status: 'cancelled' });

    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(result.current.saving).toBe(false);
  });

  it('takes no answer meant for another save', () => {
    const { result } = renderHook(() => useFileSave());
    saveAndGetRequestId(result);

    answer('wv-another-save', { status: 'saved', path: '/elsewhere.csv' });

    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(result.current.saving).toBe(true);
  });
});
