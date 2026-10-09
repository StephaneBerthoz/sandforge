import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { BaseMessage } from '@sandforge/shared';
import i18n from '../i18n';
import fr from '../i18n/locales/fr.json';

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

import { useBridgeMutation } from './useBridgeMutation';

/** Dispatch a simulated extension→webview message. */
function simulateResponse(type: string, payload: unknown, correlationId?: string): void {
  const message: BaseMessage & { payload: unknown } = {
    id: `resp-${Date.now()}`,
    type,
    timestamp: Date.now(),
    payload,
  };
  if (correlationId) {
    message.correlationId = correlationId;
  }
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

/** Answer the request in flight the way a handler does: correlated to its id. */
function replyToLastRequest(type: string, payload: unknown): void {
  const calls = mockPostMessage.mock.calls;
  const envelope = calls[calls.length - 1][0] as { payload: BaseMessage };
  simulateResponse(type, payload, envelope.payload.id);
}

describe('useBridgeMutation', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not send a message on mount', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect'),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('should send a message when mutate is called', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect'),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    expect(result.current.loading).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledOnce();

    // Outbound messages are wrapped in an envelope — unwrap payload.
    const envelope = mockPostMessage.mock.calls[0][0] as {
      payload: BaseMessage & {
        payload: { orgId: string; authMethod: string };
      };
    };
    const sentMsg = envelope.payload;
    expect(sentMsg.type).toBe('org:connect');
    expect(sentMsg.payload).toEqual({ orgId: '', authMethod: 'sfdx_import' });
  });

  it('should populate data when a matching response arrives', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect', {
        responseType: 'org:statusChanged',
      }),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    act(() => {
      replyToLastRequest('org:statusChanged', { orgId: 'org-1', status: 'connected' });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgId: 'org-1', status: 'connected' });
    expect(result.current.error).toBeNull();
  });

  it('exposes the id of the request it sent, so a page can match the operation it started', () => {
    const { result } = renderHook(() => useBridgeMutation<{ ok: boolean }>('seed:execute'));

    expect(result.current.requestId).toBeNull();

    act(() => {
      result.current.mutate({ orgId: 'org-1' });
    });

    const envelope = mockPostMessage.mock.calls[0][0] as { payload: BaseMessage };
    expect(result.current.requestId).toBe(envelope.payload.id);

    act(() => {
      result.current.reset();
    });
    expect(result.current.requestId).toBeNull();
  });

  it('returns the same object across a rerender that changes nothing', () => {
    // A fresh object on every render defeated React.memo on every component
    // that receives the mutation as a prop (the Monitor limits section).
    const { result, rerender } = renderHook(() =>
      useBridgeMutation<{ ok: boolean }>('org:connect'),
    );

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });

  it('drops the previous result when a new mutation starts', () => {
    // `mutate` used to clear `loading` and `error` but never `data`, and the
    // error channel never touches `data` either. So a run that succeeded
    // followed by one that failed left both set, and pages rendered their
    // failure banner directly above the earlier run's success summary.
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect', {
        responseType: 'org:statusChanged',
      }),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });
    act(() => {
      replyToLastRequest('org:statusChanged', { orgId: 'org-1', status: 'connected' });
    });
    expect(result.current.data).not.toBeNull();

    // Second attempt: the first result must not survive into it.
    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('should ignore non-matching response types', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect'),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    act(() => {
      simulateResponse('settings:response', { settings: {} });
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('should set error on timeout', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect', {
        timeoutMs: 5000,
      }),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    expect(result.current.loading).toBe(true);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(
      'SandForge did not answer org:connect within 5 s. Try again; if it keeps happening, look in the SandForge output channel.',
    );
    expect(result.current.data).toBeNull();
  });

  it('should support mutate without payload', () => {
    const { result } = renderHook(() => useBridgeMutation<{ orgs: string[] }>('org:list'));

    act(() => {
      result.current.mutate();
    });

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const envelope = mockPostMessage.mock.calls[0][0] as { payload: BaseMessage };
    const sentMsg = envelope.payload;
    expect(sentMsg.type).toBe('org:list');
  });

  it('should reset state when reset is called', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect', {
        responseType: 'org:statusChanged',
      }),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    act(() => {
      replyToLastRequest('org:statusChanged', { orgId: 'org-1', status: 'connected' });
    });

    expect(result.current.data).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should clean up listener on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { result, unmount } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect'),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('should cancel previous mutation when mutate is called again', () => {
    const { result } = renderHook(() => useBridgeMutation<{ orgs: string[] }>('org:list'));

    act(() => {
      result.current.mutate();
    });

    act(() => {
      result.current.mutate();
    });

    expect(mockPostMessage).toHaveBeenCalledTimes(2);

    // Only the second mutation should accept a response
    act(() => {
      replyToLastRequest('org:list:response', { orgs: ['org-2'] });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-2'] });
  });

  describe('a refusal the handler names by its code', () => {
    afterEach(async () => {
      await i18n.changeLanguage('en');
    });

    it('exposes the code the error carried, and forgets it when the next mutation starts', () => {
      const { result } = renderHook(() => useBridgeMutation('dataops:anonymize'));

      act(() => {
        result.current.mutate({ orgId: 'org-1', templateId: 'tpl-gone' });
      });
      act(() => {
        replyToLastRequest('dataops:error', {
          message: 'Template "tpl-gone" not found.',
          code: 'TEMPLATE_NOT_FOUND',
          retryable: false,
        });
      });

      expect(result.current.errorCode).toBe('TEMPLATE_NOT_FOUND');
      // A code with no translation of its own leaves the host's words as they are.
      expect(result.current.error).toBe('Template "tpl-gone" not found.');

      act(() => {
        result.current.mutate({ orgId: 'org-1', templateId: 'tpl-1' });
      });
      expect(result.current.errorCode).toBeNull();
    });

    it('says a write Production Guard refused in the panel’s language, the guard’s reason after it, not the English sentence', async () => {
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await i18n.changeLanguage('fr');
      const { result } = renderHook(() => useBridgeMutation('compare:deploy'));

      act(() => {
        result.current.mutate({ deployId: 'd-1' });
      });
      act(() => {
        replyToLastRequest('compare:error', {
          message: 'Operation blocked by Production Guard: deploy is not allowed on production',
          code: 'GUARD_BLOCKED',
          retryable: false,
        });
      });

      expect(result.current.errorCode).toBe('GUARD_BLOCKED');
      expect(result.current.error).toBe(
        "Production Guard a refusé cette opération, et rien n'a été modifié dans l'org. " +
          'Sa raison : deploy is not allowed on production',
      );
      expect(result.current.error).not.toContain('Operation blocked');
    });

    it('says a write cancelled at the guard’s confirmation in the panel’s language', async () => {
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await i18n.changeLanguage('fr');
      const { result } = renderHook(() => useBridgeMutation('sync:execute'));

      act(() => {
        result.current.mutate({ configId: 'cfg-1' });
      });
      act(() => {
        replyToLastRequest('sync:error', {
          message: 'Operation cancelled by user (production confirmation declined).',
          code: 'GUARD_DECLINED',
          retryable: false,
        });
      });

      expect(result.current.error).toBe(
        "Annulé à la confirmation de Production Guard : rien n'a été modifié dans l'org.",
      );
    });
  });
});
