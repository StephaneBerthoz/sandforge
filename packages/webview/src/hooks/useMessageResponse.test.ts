import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { BaseMessage } from '@sandforge/shared';

import i18n from '../i18n';
import fr from '../i18n/locales/fr.json';

import { RUN_OUTLIVED_WAIT, useMessageResponse } from './useMessageResponse';
import type { UseMessageResponseOptions } from './useMessageResponse';
import { useNotificationStore } from '../stores/useNotificationStore';
import { useAppStore } from '../stores/useAppStore';
import { useOrgStore } from '../stores/useOrgStore';

/** Dispatch a simulated extension-to-webview message. */
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

const defaultOptions: UseMessageResponseOptions = {
  requestType: 'org:list',
  responseType: 'org:list:response',
  timeoutMs: 5000,
};

describe('useMessageResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start with idle state', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should listen for the correct response type and populate data', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-1', 'org-2'] }, 'req-1');
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-1', 'org-2'] });
    expect(result.current.error).toBeNull();
  });

  it('should set error on timeout', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(
      'SandForge did not answer org:list within 5 s. Try again; if it keeps happening, look in the SandForge output channel.',
    );
    expect(result.current.data).toBeNull();
  });

  it('writes the timeout in the interface language', async () => {
    // It used to be developer text in English whatever the language:
    // "Bridge query 'org:list' timed out after 5000ms".
    i18n.addResourceBundle('fr', 'translation', fr);
    vi.useRealTimers();
    await i18n.changeLanguage('fr');
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMessageResponse<unknown>(defaultOptions));
      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-fr');
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current.error).toBe(
        "SandForge n'a pas répondu à org:list en 5 s. Réessayez ; si cela se reproduit, consultez le canal de sortie SandForge.",
      );
    } finally {
      vi.useRealTimers();
      await i18n.changeLanguage('en');
      vi.useFakeTimers();
    }
  });

  it('says a run it stopped waiting for may still be writing, and never to try again', () => {
    // A seed's page gave up after 120 s and said "Try again" while the run went
    // on in the extension: a second run wrote its records twice.
    const { result } = renderHook(() =>
      useMessageResponse<unknown>({
        requestType: 'seed:execute',
        responseType: 'seed:execute:response',
        timeoutMs: 12 * 60 * 60 * 1000,
        runOutlivesWait: true,
      }),
    );

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-run');
    });
    act(() => {
      vi.advanceTimersByTime(12 * 60 * 60 * 1000);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(
      "SandForge stopped waiting for seed:execute after 12 h, but the run may still be writing. Monitor's Live Operations shows where it is; starting it again would write its records twice.",
    );
    expect(result.current.error).not.toContain('Try again');
    // Under a code of its own, so a page keeps the run in view rather than fail it.
    expect(result.current.errorCode).toBe(RUN_OUTLIVED_WAIT);
  });

  it('names the unanswered request in the timeout message', () => {
    const { result } = renderHook(() =>
      useMessageResponse<unknown>({
        ...defaultOptions,
        requestType: 'org:connect',
      }),
    );

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.error).toContain('org:connect');
  });

  it('should clean up event listener via returned cleanup function', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    let cleanup: () => void = () => undefined;
    act(() => {
      cleanup = result.current.listen('req-1');
    });

    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));

    act(() => {
      cleanup();
    });

    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('should ignore non-matching response types', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      simulateResponse('settings:response', { settings: {} });
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('should reset all state when reset is called', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-1'] }, 'req-1');
    });

    expect(result.current.data).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should not update state after unmount', () => {
    const { result, unmount } = renderHook(() =>
      useMessageResponse<{ orgs: string[] }>(defaultOptions),
    );

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    unmount();

    act(() => {
      simulateResponse('org:list:response', { orgs: ['late'] }, 'req-1');
    });

    // After unmount, the last captured state should remain unchanged
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('should ignore stale responses when a new listen call replaces the active request', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    // Start a second listen, making req-1 stale
    act(() => {
      result.current.listen('req-2');
    });

    // A reply correlated to req-1 must be ignored: activeRequestId is req-2.
    act(() => {
      simulateResponse('org:list:response', { orgs: ['stale'] }, 'req-1');
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    // req-2's own reply closes it.
    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-1'] }, 'req-2');
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-1'] });
  });

  it('should accept response with matching correlationId', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-42');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-a'] }, 'req-42');
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-a'] });
  });

  it('should reject response with wrong correlationId', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-42');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['wrong'] }, 'req-99');
    });

    // Response should be rejected — still loading
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('does not answer a pending request with an uncorrelated message of its type', () => {
    // Handler replies are correlated at the source, so an uncorrelated message
    // of a response type is a host broadcast. Taken by type, one landing
    // between a request and its reply closed the request, and the reply that
    // actually answered it was then dropped as stale.
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-42');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['pushed'] });
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    act(() => {
      simulateResponse('org:list:response', { orgs: ['answer'] }, 'req-42');
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['answer'] });
  });

  it('takes the uncorrelated push where the caller opted in', () => {
    // Taking a push by type alone stays possible, but only for a caller that
    // asks for it.
    const { result } = renderHook(() =>
      useMessageResponse<{ orgs: string[] }>({ ...defaultOptions, acceptUncorrelated: true }),
    );

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-42');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['pushed'] });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['pushed'] });
  });

  it('ignores an uncorrelated message of the response type when told to, and still takes its own reply', () => {
    // `ai:status:response` is also pushed with no request behind it whenever
    // the AI wiring changes. Accepted by type, that push closed the Settings
    // query it happened to land on, and the real reply was then dropped.
    // Settings states the refusal rather than leaning on the default.
    const { result } = renderHook(() =>
      useMessageResponse<{ enabled: boolean }>({
        requestType: 'ai:status',
        responseType: 'ai:status:response',
        timeoutMs: 5000,
        acceptUncorrelated: false,
      }),
    );

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-status');
    });

    act(() => {
      simulateResponse('ai:status:response', { enabled: false });
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    act(() => {
      simulateResponse('ai:status:response', { enabled: true }, 'req-status');
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ enabled: true });
  });

  it('should allow setLoading and setError to be called externally', () => {
    const { result } = renderHook(() => useMessageResponse<unknown>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
    });
    expect(result.current.loading).toBe(true);

    act(() => {
      result.current.setError('custom error');
    });
    expect(result.current.error).toBe('custom error');

    act(() => {
      result.current.setLoading(false);
      result.current.setError(null);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  describe('envelope rejection (bridge:error)', () => {
    it('fails the request the broker actually dropped, instead of timing out', () => {
      // bridge:error fires when the envelope loses Zod validation, before any
      // handler sees the message — so no `<domain>:error` will ever arrive and
      // the hook would sit out its whole timeout showing the raw timeout text.
      const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-77');
      });

      act(() => {
        simulateResponse(
          'bridge:error',
          { reason: 'invalid-payload', details: 'payload.limit: expected number' },
          'req-77',
        );
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.timedOut).toBe(false);
      expect(result.current.error).toContain('org:list');
    });

    it('does NOT claim a rejection belonging to another request', () => {
      // The regression this replaces: bridge:error carried no correlationId, so
      // the only way to claim it was a time window, and every hook whose
      // request was younger than that window reported someone else's failure.
      const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-mine');
      });

      act(() => {
        simulateResponse(
          'bridge:error',
          { reason: 'invalid-payload', details: 'someone else' },
          'req-someone-else',
        );
      });

      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(true);
    });

    it('ignores an unattributable rejection rather than blaming the nearest request', () => {
      // A payload too malformed to yield an id still produces a bridge:error.
      // Nobody can own that one, and guessing is what caused the regression.
      const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-mine');
      });

      act(() => {
        simulateResponse('bridge:error', { reason: 'invalid-payload', details: 'no id' });
      });

      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(true);
    });
  });

  describe('error channel (errorType)', () => {
    const optionsWithError: UseMessageResponseOptions = {
      ...defaultOptions,
      errorType: 'org:error',
    };

    it('should surface the handler error message immediately instead of timing out', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });

      act(() => {
        simulateResponse('org:error', { message: 'org unreachable', code: 'CONN_FAIL' }, 'req-1');
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe('org unreachable');
      expect(result.current.data).toBeNull();

      // The timeout timer must have been cleared: advancing past timeoutMs
      // must not overwrite the handler error.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current.error).toBe('org unreachable');
    });

    it.each([
      ['AUTOPILOT_STORAGE_EXCEEDED', 'common.refusal.autopilotStorageExceeded'],
      ['AUTOPILOT_WRITE_DECLINED', 'common.refusal.autopilotWriteDeclined'],
      ['AUTOPILOT_CONFIRMATION_UNAVAILABLE', 'common.refusal.autopilotConfirmationUnavailable'],
      ['AUTOPILOT_RUNNING', 'common.refusal.autopilotRunning'],
      // A seed the user declined at the question its unread storage asks.
      ['SEED_WRITE_DECLINED', 'common.refusal.seedWriteDeclined'],
    ])(
      'says an Autopilot run its write gate, or a run still writing, stopped (%s) in the interface language',
      (code, key) => {
        const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));

        act(() => {
          result.current.setLoading(true);
          result.current.listen('req-1');
        });
        act(() => {
          simulateResponse('org:error', { message: 'Nothing was written.', code }, 'req-1');
        });

        expect(result.current.errorCode).toBe(code);
        expect(result.current.error).toBe(i18n.t(key));
        expect(result.current.error).not.toBe('Nothing was written.');
      },
    );

    it('says an expired session in the interface language, and offers Reconnect on its org', () => {
      useNotificationStore.setState({ notifications: [] });
      useAppStore.setState({ currentRoute: 'seed', navigationIntent: null });
      useOrgStore.setState({
        orgs: [{ id: 'org-7', alias: 'my-dev-org', username: 'u@example.com' }] as never,
      });
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));
      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });
      act(() => {
        simulateResponse(
          'org:error',
          {
            message: 'ORG_AUTH_EXPIRED: The session with "my-dev-org" has expired…',
            code: 'ORG_AUTH_EXPIRED',
            orgId: 'org-7',
          },
          'req-1',
        );
      });

      expect(result.current.error).toBe(
        `${i18n.t('errors.orgAuthExpired.explanation')} ${i18n.t('errors.orgAuthExpired.action')}`,
      );
      const [toast] = useNotificationStore.getState().notifications;
      expect(toast.message).toBe(i18n.t('bridge.sessionExpired.message', { org: 'my-dev-org' }));
      act(() => toast.actions?.[0].onAction?.());
      expect(useAppStore.getState().currentRoute).toBe('orgs');
      expect(useAppStore.getState().navigationIntent).toEqual({
        route: 'orgs',
        reconnectOrgId: 'org-7',
      });
    });

    it('says an import that found no org in the CLI by the catalogue, with no terminal command', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));
      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });
      act(() => {
        simulateResponse(
          'org:error',
          {
            message:
              'The Salesforce CLI holds no connected org yet. Sign in with OAuth (Web) on the Organizations page.',
            code: 'NO_CLI_ORGS',
          },
          'req-1',
        );
      });

      expect(result.current.error).toBe(
        `${i18n.t('errors.noCliOrgs.explanation')} ${i18n.t('errors.noCliOrgs.action')}`,
      );
      expect(result.current.errorCode).toBe('NO_CLI_ORGS');
    });

    it('says an org left alone after repeated failures in the interface language, with no circuit breaker', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));
      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });
      act(() => {
        simulateResponse(
          'org:error',
          { message: 'ORG_TEMPORARILY_UNREACHABLE: …', code: 'ORG_TEMPORARILY_UNREACHABLE' },
          'req-1',
        );
      });

      expect(result.current.error).toBe(
        `${i18n.t('errors.orgTemporarilyUnreachable.explanation')} ${i18n.t('errors.orgTemporarilyUnreachable.action')}`,
      );
      expect(result.current.error).not.toMatch(/circuit/i);
    });

    it('says a seed its data storage stopped in the interface language, with the figures', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));
      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });
      act(() => {
        simulateResponse(
          'org:error',
          {
            message:
              'The records to write take about 14.9 MB of data storage. Nothing was written.',
            code: 'SEED_STORAGE_EXCEEDED',
            estimateMB: 14.9,
            remainingMB: 5,
            maxMB: 5,
            org: 'my-dev-org',
          },
          'req-1',
        );
      });
      expect(result.current.errorCode).toBe('SEED_STORAGE_EXCEEDED');
      expect(result.current.error).toBe(
        i18n.t('common.refusal.seedStorageExceeded', {
          estimate: 14.9,
          remaining: 5,
          max: 5,
          org: 'my-dev-org',
        }),
      );
      expect(result.current.error).toContain('14.9');
      expect(result.current.error).toContain('my-dev-org');
      expect(result.current.error).not.toContain('Nothing was written');
    });

    it('says a seed its emails stopped in the interface language, with the figures and the ways out', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));
      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });
      act(() => {
        simulateResponse(
          'org:error',
          {
            message: 'The seed was refused before it wrote anything. Nothing was written.',
            code: 'SEED_EMAILS_EXCEEDED',
            org: 'my-dev-org',
            limit: 'SingleEmail',
            emails: 225,
            remaining: 15,
            max: 15,
            objects: ['Contact'],
            senders: ['Contact_Welcome', 'Welcome Email'],
            bypasses: [],
          },
          'req-1',
        );
      });
      expect(result.current.errorCode).toBe('SEED_EMAILS_EXCEEDED');
      expect(result.current.error).toBe(
        'The seed was refused before it wrote anything. Single emails these records would make ' +
          'my-dev-org send: about 225, with 15 of 15 left today. Lower the record counts, set ' +
          'Contact to 0, turn off “Contact_Welcome” and “Welcome Email”, or give yourself the ' +
          'permission that keeps them quiet.',
      );

      // Without its figures, the host's own words.
      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-2');
      });
      act(() => {
        simulateResponse(
          'org:error',
          { message: 'Too many emails.', code: 'SEED_EMAILS_EXCEEDED' },
          'req-2',
        );
      });
      expect(result.current.error).toBe('Too many emails.');
    });

    it("keeps the host's words for a storage refusal that came without its figures", () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));
      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });
      act(() => {
        simulateResponse(
          'org:error',
          { message: 'Too big.', code: 'SEED_STORAGE_EXCEEDED' },
          'req-1',
        );
      });
      expect(result.current.error).toBe('Too big.');
    });

    it('should use a generic message when the error payload has no message string', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });

      act(() => {
        simulateResponse('org:error', { code: 'UNKNOWN' }, 'req-1');
      });

      expect(result.current.error).toBe(
        'org:list failed without a reason from SandForge. Look in the SandForge output channel.',
      );
    });

    it('should ignore error channel messages with a wrong correlationId', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-42');
      });

      act(() => {
        simulateResponse('org:error', { message: 'not for us' }, 'req-99');
      });

      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('should not fail on the error channel of an already-answered request', () => {
      const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(optionsWithError));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });
      act(() => {
        simulateResponse('org:list:response', { orgs: ['a'] }, 'req-1');
      });
      act(() => {
        simulateResponse('org:error', { message: 'late error' }, 'req-1');
      });

      expect(result.current.error).toBeNull();
      expect(result.current.data).toEqual({ orgs: ['a'] });
    });
  });

  describe('error attribution across concurrent requests of one domain', () => {
    // useBridgeQuery and useBridgeMutation both default `errorType` to
    // `<domain>:error`, so every hook of a domain is subscribed to the same
    // error channel at once. Who owns a given error is decided here and
    // nowhere else.
    const syncOptions: UseMessageResponseOptions = {
      requestType: 'sync:execute',
      responseType: 'sync:execute:response',
      timeoutMs: 5000,
      errorType: 'sync:error',
    };

    it('claims an error correlated to its own request, and closes the request', () => {
      const { result } = renderHook(() => useMessageResponse<{ status: string }>(syncOptions));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-mine');
      });

      act(() => {
        simulateResponse('sync:error', { message: 'sync failed' }, 'req-mine');
      });

      expect(result.current.error).toBe('sync failed');
      expect(result.current.loading).toBe(false);

      // Correlated means certain: the request is over and nothing revives it.
      act(() => {
        simulateResponse('sync:execute:response', { status: 'success' }, 'req-mine');
      });

      expect(result.current.data).toBeNull();
      expect(result.current.error).toBe('sync failed');
    });

    it('never claims an error correlated to another request', () => {
      const { result } = renderHook(() => useMessageResponse<{ status: string }>(syncOptions));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-mine');
      });

      act(() => {
        simulateResponse('sync:error', { message: 'describe failed on Account' }, 'req-describe');
      });

      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(true);

      act(() => {
        simulateResponse('sync:execute:response', { status: 'success' }, 'req-mine');
      });

      expect(result.current.data).toEqual({ status: 'success' });
    });

    it('ignores an error that names no request, and still takes its own response', () => {
      // Every handler error names its request now — `sendHandlerError` takes a
      // typed origin — so an error without a correlationId cannot be
      // attributed. Claiming it is how a multi-minute sync used to show
      // "describe failed on Account": another request's failure.
      const { result } = renderHook(() => useMessageResponse<{ status: string }>(syncOptions));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-execute');
      });

      act(() => {
        simulateResponse('sync:error', { message: 'describe failed on Account' });
      });

      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(true);

      act(() => {
        simulateResponse('sync:execute:response', { status: 'success' }, 'req-execute');
      });

      expect(result.current.data).toEqual({ status: 'success' });
      expect(result.current.loading).toBe(false);
    });
  });
});
