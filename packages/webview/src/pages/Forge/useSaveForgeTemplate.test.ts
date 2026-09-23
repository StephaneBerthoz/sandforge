import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { BaseMessage, ForgeTemplate } from '@sandforge/shared';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { useSaveForgeTemplate } from './useSaveForgeTemplate';
import { useForgeStore } from '../../stores/useForgeStore';

const TEMPLATE: ForgeTemplate = {
  id: 'tpl-1',
  name: 'Energy accounts',
  description: '',
  config: {
    inputMode: 'soql',
    soqlQuery: 'SELECT Id FROM Account',
    depth: 'direct',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
  },
  targetOrgId: 'org-target',
  objectCount: 1,
  recordCount: 10,
  createdAt: '2026-09-01T08:00:00.000Z',
  lastUsedAt: '2026-09-01T08:00:00.000Z',
};

/** Answer the last save the hook sent, on `type`, correlated as the handler does. */
function answer(type: string, payload: unknown): void {
  const request = mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage })
    .filter((envelope) => envelope.payload.type === 'forge:templates:save')
    .pop();
  if (!request) throw new Error('no save was sent');
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'resp',
          type,
          timestamp: Date.now(),
          correlationId: request.payload.id,
          payload,
        },
      }),
    );
  });
}

describe('useSaveForgeTemplate', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.getState().reset();
  });

  it('sends the template to the extension and lists it once the extension kept it', () => {
    const { result } = renderHook(() => useSaveForgeTemplate());

    act(() => result.current.save(TEMPLATE));

    const [envelope] = mockPostMessage.mock.calls.map(
      (call) => call[0] as { payload: BaseMessage & { payload: unknown } },
    );
    expect(envelope.payload.type).toBe('forge:templates:save');
    expect(envelope.payload.payload).toEqual({ template: TEMPLATE });
    expect(result.current.saving).toBe(true);
    expect(useForgeStore.getState().templates).toEqual([]);

    answer('forge:templates:save:response', { success: true });

    expect(useForgeStore.getState().templates).toEqual([TEMPLATE]);
    expect(result.current.saved).toEqual(TEMPLATE);
    expect(result.current.saving).toBe(false);
  });

  it('lists nothing, and says why, when the extension could not keep it', () => {
    const { result } = renderHook(() => useSaveForgeTemplate());

    act(() => result.current.save(TEMPLATE));
    answer('forge:templates:save:error', {
      message: 'EACCES: permission denied',
      code: 'UNKNOWN',
      retryable: false,
    });

    expect(useForgeStore.getState().templates).toEqual([]);
    expect(result.current.saved).toBeNull();
    expect(result.current.error).toBe('EACCES: permission denied');
  });
});
