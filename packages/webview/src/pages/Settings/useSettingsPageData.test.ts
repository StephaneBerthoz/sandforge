import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSettingsPageData } from './useSettingsPageData';
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

  it('should persist the LIVE i18n language on save, not the local snapshot', async () => {
    const mutateSpy = vi.fn();
    const mockedMutation = vi.mocked(useBridgeMutation);
    // Route the settings:update mutation to the spy.
    mockedMutation.mockImplementation(
      ((type: string) => ({
        mutate: type === 'settings:update' ? mutateSpy : vi.fn(),
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
      })) as unknown as typeof useBridgeMutation,
    );
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
      mockedMutation.mockImplementation(
        (() => ({
          mutate: vi.fn(),
          data: null,
          loading: false,
          error: null,
          reset: vi.fn(),
        })) as unknown as typeof useBridgeMutation,
      );
    }
  });
});
