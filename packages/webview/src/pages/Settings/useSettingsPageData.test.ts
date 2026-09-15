import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSettingsPageData } from './useSettingsPageData';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import i18n from '../../i18n';
import { defaultSettings } from './SettingsPage';
import type { SettingsValues } from './SettingsPage';
import type { BaseMessage } from '@sandforge/shared';

/** Captures what the real bridge hooks post, when a test delegates to them. */
const vscode = vi.hoisted(() => ({ postMessage: vi.fn() }));

vi.mock('../../hooks/useVSCodeApi', () => {
  const api = {
    postMessage: (message: unknown) => vscode.postMessage(message),
    getState: () => undefined,
    setState: () => undefined,
  };
  return { useVSCodeApi: () => api };
});

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: vi.fn(() => ({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: vi.fn(() => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
  })),
}));

describe('useSettingsPageData', () => {
  it('should return default settings when no initial settings provided', () => {
    const { result } = renderHook(() => useSettingsPageData());

    expect(result.current.settings).toEqual(defaultSettings);
  });

  it('should return initial settings when provided', () => {
    const custom: SettingsValues = { ...defaultSettings, language: 'fr' };
    const { result } = renderHook(() => useSettingsPageData(custom));

    expect(result.current.settings.language).toBe('fr');
  });

  it('should update a single setting', () => {
    const { result } = renderHook(() => useSettingsPageData());

    act(() => {
      result.current.updateSetting('language', 'fr');
    });

    expect(result.current.settings.language).toBe('fr');
  });

  it('should call onSave callback on handleSave', () => {
    const onSave = vi.fn();
    const { result } = renderHook(() => useSettingsPageData(undefined, onSave));

    act(() => {
      result.current.handleSave();
    });

    expect(onSave).toHaveBeenCalledWith(defaultSettings);
  });

  it('should reset to defaults on handleReset', () => {
    const onReset = vi.fn();
    const { result } = renderHook(() => useSettingsPageData(undefined, undefined, onReset));

    act(() => {
      result.current.updateSetting('language', 'fr');
    });

    expect(result.current.settings.language).toBe('fr');

    act(() => {
      result.current.handleReset();
    });

    expect(result.current.settings.language).toBe('en');
    expect(onReset).toHaveBeenCalled();
  });

  it('should manage AI API key state', () => {
    const { result } = renderHook(() => useSettingsPageData());

    expect(result.current.aiApiKey).toBe('');
    expect(result.current.aiKeySaved).toBe(false);

    act(() => {
      result.current.setAiApiKey('sk-test-key');
    });

    expect(result.current.aiApiKey).toBe('sk-test-key');
  });

  describe('AI key save → status refresh', () => {
    /**
     * Wires the ai:status query to `refetch` and reports the ai:save-key
     * mutation as already succeeded, so mounting the hook replays exactly
     * what happens right after the user saves a key.
     */
    function mockSavedKey(refetch: () => void): void {
      // Stable reference: the real mutation hook keeps the same `data` object
      // until a new response lands, and the refresh effect keys off identity.
      const saveKeyResponse = { success: true };
      vi.mocked(useBridgeQuery).mockImplementation(((requestType: string) => ({
        data: null,
        loading: false,
        error: null,
        refetch: requestType === 'ai:status' ? refetch : vi.fn(),
      })) as unknown as typeof useBridgeQuery);
      vi.mocked(useBridgeMutation).mockImplementation(((requestType: string) => ({
        mutate: vi.fn(),
        data: requestType === 'ai:save-key' ? saveKeyResponse : null,
        loading: false,
        error: null,
        reset: vi.fn(),
      })) as unknown as typeof useBridgeMutation);
    }

    function restoreBridgeMocks(): void {
      vi.mocked(useBridgeQuery).mockImplementation((() => ({
        data: null,
        loading: false,
        error: null,
        refetch: vi.fn(),
      })) as unknown as typeof useBridgeQuery);
      vi.mocked(useBridgeMutation).mockImplementation((() => ({
        mutate: vi.fn(),
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
      })) as unknown as typeof useBridgeMutation);
    }

    it('re-probes AI status after the host had time to wire the assistant', () => {
      vi.useFakeTimers();
      const refetch = vi.fn();
      mockSavedKey(refetch);
      try {
        renderHook(() => useSettingsPageData());

        // Immediate probe can still catch the host mid-init…
        expect(refetch).toHaveBeenCalledTimes(1);

        act(() => {
          vi.advanceTimersByTime(2_000);
        });

        // …so a second one must land once the AI stack is up.
        expect(refetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
        restoreBridgeMocks();
      }
    });

    it('drops the pending re-probe when the page unmounts', () => {
      vi.useFakeTimers();
      const refetch = vi.fn();
      mockSavedKey(refetch);
      try {
        const { unmount } = renderHook(() => useSettingsPageData());
        expect(refetch).toHaveBeenCalledTimes(1);

        unmount();
        act(() => {
          vi.advanceTimersByTime(2_000);
        });

        expect(refetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        restoreBridgeMocks();
      }
    });
  });

  it('waits for the reply to its own AI status check when an unprompted status update lands first', async () => {
    // The extension pushes ai:status:response whenever the AI wiring changes.
    // Taken as the answer, that push closed the check and the real reply was
    // dropped.
    const actual = await vi.importActual<{ useBridgeQuery: typeof useBridgeQuery }>(
      '../../hooks/useBridgeQuery',
    );
    const mockedQuery = vi.mocked(useBridgeQuery);
    const previous = mockedQuery.getMockImplementation();
    mockedQuery.mockImplementation(actual.useBridgeQuery);
    vscode.postMessage.mockClear();
    const deliver = (payload: unknown, correlationId?: string): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: `ext-${Math.random()}`,
            type: 'ai:status:response',
            timestamp: Date.now(),
            ...(correlationId ? { correlationId } : {}),
            payload,
          },
        }),
      );
    };
    try {
      const { result } = renderHook(() => useSettingsPageData());
      const statusRequest = vscode.postMessage.mock.calls
        .map((call) => (call[0] as { payload: BaseMessage }).payload)
        .find((message) => message.type === 'ai:status');
      expect(statusRequest).toBeDefined();
      expect(result.current.aiStatusLoading).toBe(true);

      act(() => {
        deliver({ enabled: false, provider: '', model: '' });
      });

      expect(result.current.aiStatusLoading).toBe(true);
      expect(result.current.aiStatus).toBeUndefined();

      act(() => {
        deliver({ enabled: true, provider: 'anthropic', model: 'model-a' }, statusRequest?.id);
      });

      expect(result.current.aiStatusLoading).toBe(false);
      expect(result.current.aiStatus).toEqual({
        enabled: true,
        provider: 'anthropic',
        model: 'model-a',
      });
    } finally {
      if (previous) mockedQuery.mockImplementation(previous);
    }
  });

  it('should persist the LIVE i18n language on save, not the local snapshot', async () => {
    const mutateSpy = vi.fn();
    const mockedMutation = vi.mocked(useBridgeMutation);
    // Route the settings:update mutation to the spy.
    mockedMutation.mockImplementation(((type: string) => ({
      mutate: type === 'settings:update' ? mutateSpy : vi.fn(),
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    })) as unknown as typeof useBridgeMutation);
    try {
      const onSave = vi.fn();
      const { result } = renderHook(() => useSettingsPageData(undefined, onSave));
      // Local snapshot is 'en' (boot default)…
      expect(result.current.settings.language).toBe('en');

      // …but the live language moved afterwards (Welcome wizard, blob
      // recovery): the blob must carry the LIVE value, never the stale
      // local one — otherwise saving erases the user's real choice.
      await i18n.changeLanguage('fr');
      act(() => {
        result.current.handleSave();
      });

      expect(mutateSpy).toHaveBeenCalledWith({
        key: 'settings',
        value: expect.objectContaining({ language: 'fr' }),
      });
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ language: 'fr' }));
    } finally {
      await i18n.changeLanguage('en');
      mockedMutation.mockImplementation((() => ({
        mutate: vi.fn(),
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
      })) as unknown as typeof useBridgeMutation);
    }
  });
});
