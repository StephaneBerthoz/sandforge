import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { BaseMessage, ForgeRootsPreview } from '@sandforge/shared';
import '../../i18n';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({ useVSCodeApi: () => stableApi }));

import { ROOTS_PREVIEW_DELAY_MS, useRootsPreview } from './useRootsPreview';

const ENERGY = "SELECT Id FROM Account WHERE Industry = 'Energy'";

/** The requests sent, unwrapped from their envelope. */
const requests = (): BaseMessage[] =>
  mockPostMessage.mock.calls.map(([envelope]) => (envelope as { payload: BaseMessage }).payload);

/** Answer the last request as the extension does: correlated to its id. */
function answer(type: string, payload: unknown): void {
  const last = requests().at(-1);
  const message = {
    id: `resp-${Date.now()}`,
    type,
    timestamp: Date.now(),
    payload,
    ...(last ? { correlationId: last.id } : {}),
  };
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

const preview = (more: Partial<ForgeRootsPreview> = {}): ForgeRootsPreview => ({
  sourceOrgId: 'src',
  soqlQuery: ENERGY,
  objectApiName: 'Account',
  cap: 200,
  chosen: 37,
  more: false,
  requests: 1,
  ...more,
});

describe('useRootsPreview', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads what the query chooses once it has stayed as it is, one read for the whole of the typing', () => {
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useRootsPreview({ sourceOrgId: 'src', query, enabled: true }),
      { initialProps: { query: 'SELECT Id FROM Acc' } },
    );
    rerender({ query: 'SELECT Id FROM Account' });
    rerender({ query: ENERGY });
    expect(result.current.status).toBe('reading');
    expect(requests()).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(ROOTS_PREVIEW_DELAY_MS);
    });

    expect(requests().map((r) => [r.type, (r as { payload?: unknown }).payload])).toEqual([
      ['forge:previewRoots', { sourceOrgId: 'src', soqlQuery: ENERGY }],
    ]);
    answer('forge:previewRoots:response', preview());
    expect(result.current).toMatchObject({ status: 'read', preview: preview() });
  });

  it('shows no answer for another query than the one the form now holds', () => {
    const { result } = renderHook(() =>
      useRootsPreview({ sourceOrgId: 'src', query: ENERGY, enabled: true }),
    );
    act(() => {
      vi.advanceTimersByTime(ROOTS_PREVIEW_DELAY_MS);
    });

    answer('forge:previewRoots:response', preview({ soqlQuery: 'SELECT Id FROM Contact' }));

    expect(result.current.status).toBe('reading');
    expect(result.current.preview).toBeUndefined();
  });

  it('says a read the extension refused, with its words', () => {
    const { result } = renderHook(() =>
      useRootsPreview({ sourceOrgId: 'src', query: ENERGY, enabled: true }),
    );
    act(() => {
      vi.advanceTimersByTime(ROOTS_PREVIEW_DELAY_MS);
    });

    answer('forge:previewRoots:error', {
      message: "No such column 'Nope__c'",
      code: 'ROOTS_PREVIEW_ERROR',
      retryable: true,
    });

    expect(result.current).toMatchObject({ status: 'failed', error: "No such column 'Nope__c'" });
  });

  it('reads nothing without a source, a query, or for a query it was told not to read', () => {
    const { result, rerender } = renderHook(
      (input: { sourceOrgId: string; query: string | undefined; enabled: boolean }) =>
        useRootsPreview(input),
      {
        initialProps: {
          sourceOrgId: '',
          query: ENERGY as string | undefined,
          enabled: true,
        },
      },
    );
    act(() => {
      vi.advanceTimersByTime(ROOTS_PREVIEW_DELAY_MS);
    });
    expect(result.current.status).toBe('idle');

    rerender({ sourceOrgId: 'src', query: ENERGY, enabled: false });
    act(() => {
      vi.advanceTimersByTime(ROOTS_PREVIEW_DELAY_MS);
    });
    expect(result.current.status).toBe('idle');

    rerender({ sourceOrgId: 'src', query: undefined, enabled: true });
    expect(result.current.status).toBe('idle');
    expect(requests()).toEqual([]);
  });

  it('reads again when asked, the setting changed meanwhile', () => {
    const { result } = renderHook(() =>
      useRootsPreview({ sourceOrgId: 'src', query: ENERGY, enabled: true }),
    );
    act(() => {
      vi.advanceTimersByTime(ROOTS_PREVIEW_DELAY_MS);
    });
    answer('forge:previewRoots:response', preview({ more: true, chosen: 200 }));

    act(() => result.current.readAgain());
    answer('forge:previewRoots:response', preview({ cap: 500, chosen: 312 }));

    expect(requests().filter((r) => r.type === 'forge:previewRoots')).toHaveLength(2);
    expect(result.current.preview).toMatchObject({ cap: 500, chosen: 312, more: false });
  });
});
