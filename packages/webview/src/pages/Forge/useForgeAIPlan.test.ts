import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { BaseMessage } from '@sandforge/shared';

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

import { useForgeAIPlan } from './useForgeAIPlan';

const DRAFT = "SELECT Id FROM Account WHERE Industry = 'Energy'";

/** The payloads of every `ai:forge-plan` the hook posted. */
function requests(): Array<Record<string, unknown>> {
  return mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } })
    .filter((envelope) => envelope.payload.type === 'ai:forge-plan')
    .map((envelope) => envelope.payload.payload);
}

/** Answer the last `ai:forge-plan` on `type`, correlated as the handler does. */
function answer(payload: unknown, type = 'ai:forge-plan:response'): void {
  const request = mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage })
    .filter((envelope) => envelope.payload.type === 'ai:forge-plan')
    .pop();
  if (!request) throw new Error('nothing was sent');
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

const CHECKED = {
  success: true,
  soql: DRAFT,
  explanation: 'Accounts in the energy industry',
  rootObject: 'Account',
  rootLabel: 'Account',
  fieldsChecked: 2,
  problems: [],
};

describe('useForgeAIPlan', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('sends nothing without a prompt, or without an org to check against', () => {
    const { result, rerender } = renderHook(({ org }) => useForgeAIPlan(org), {
      initialProps: { org: 'org-src' },
    });

    act(() => result.current.requestDraft());
    expect(requests()).toEqual([]);

    act(() => result.current.setPrompt('energy accounts'));
    rerender({ org: '' });
    act(() => result.current.requestDraft());
    expect(requests()).toEqual([]);
  });

  it('puts the draft in the field with its verdict, which holds for that query and org', () => {
    const { result } = renderHook(() => useForgeAIPlan('org-src'));

    act(() => result.current.setPrompt('  energy accounts  '));
    act(() => result.current.requestDraft());
    expect(requests()).toEqual([{ orgId: 'org-src', prompt: 'energy accounts' }]);
    expect(result.current.busy).toBe(true);

    answer(CHECKED);

    expect(result.current.draft).toBe(DRAFT);
    expect(result.current.checked).toBe(true);
    expect(result.current.stale).toBe(false);
    expect(result.current.verdict).toMatchObject({
      soql: DRAFT,
      orgId: 'org-src',
      rootObject: 'Account',
      fieldsChecked: 2,
      explanation: 'Accounts in the energy industry',
    });
  });

  it('no longer counts the query as checked once it is edited', () => {
    const { result } = renderHook(() => useForgeAIPlan('org-src'));
    act(() => result.current.setPrompt('energy accounts'));
    act(() => result.current.requestDraft());
    answer(CHECKED);

    act(() => result.current.setDraft(`${DRAFT} AND Rating = 'Hot'`));

    expect(result.current.checked).toBe(false);
    expect(result.current.stale).toBe(true);
  });

  it('no longer counts the query as checked against another source org', () => {
    const { result, rerender } = renderHook(({ org }) => useForgeAIPlan(org), {
      initialProps: { org: 'org-src' },
    });
    act(() => result.current.setPrompt('energy accounts'));
    act(() => result.current.requestDraft());
    answer(CHECKED);

    rerender({ org: 'org-other' });

    expect(result.current.checked).toBe(false);
    expect(result.current.stale).toBe(true);
  });

  it('checks an edited query again without the prompt, and keeps the text as typed', () => {
    const { result } = renderHook(() => useForgeAIPlan('org-src'));
    act(() => result.current.setPrompt('energy accounts'));
    act(() => result.current.requestDraft());
    answer(CHECKED);
    const edited = `${DRAFT} AND Rating = 'Hot'`;
    act(() => result.current.setDraft(`${edited}\n`));

    act(() => result.current.recheck());
    expect(requests()[1]).toEqual({ orgId: 'org-src', soql: edited });
    answer({ ...CHECKED, soql: edited, fieldsChecked: 3 });

    expect(result.current.draft).toBe(`${edited}\n`);
    expect(result.current.checked).toBe(true);
  });

  it('keeps a failed verdict as not checked', () => {
    const { result } = renderHook(() => useForgeAIPlan('org-src'));
    act(() => result.current.setPrompt('energy accounts'));
    act(() => result.current.requestDraft());

    answer({
      ...CHECKED,
      success: false,
      problems: [{ kind: 'org-refused', detail: 'MALFORMED_QUERY: unexpected token' }],
    });

    expect(result.current.checked).toBe(false);
    expect(result.current.stale).toBe(false);
    expect(result.current.verdict?.problems).toHaveLength(1);
  });

  it('says why nothing came back, and when no provider is set up', () => {
    const { result } = renderHook(() => useForgeAIPlan('org-src'));
    act(() => result.current.setPrompt('energy accounts'));
    act(() => result.current.requestDraft());

    answer({
      success: false,
      code: 'AI_NOT_CONFIGURED',
      error: 'AI not configured. Set your API key in Settings > AI.',
    });

    expect(result.current.notConfigured).toBe(true);
    expect(result.current.error).toContain('Settings');
    expect(result.current.verdict).toBeNull();
  });
});
