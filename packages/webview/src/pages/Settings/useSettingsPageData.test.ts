import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSettingsPageData } from './useSettingsPageData';
import { defaultSettings } from './SettingsPage';

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
    const custom = { ...defaultSettings, language: 'fr' };
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
});
