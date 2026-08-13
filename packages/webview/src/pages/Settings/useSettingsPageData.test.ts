import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSettingsPageData } from './useSettingsPageData';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import i18n from '../../i18n';
import { defaultSettings } from './SettingsPage';
import type { SettingsValues } from './SettingsPage';

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
