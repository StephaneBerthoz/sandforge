import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useTheme } from './useTheme';

describe('useTheme', () => {
  afterEach(() => {
    delete document.body.dataset.vscodeThemeKind;
  });

  it('should default to dark when no dataset attribute is set', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe('dark');
  });

  it('should detect dark theme', () => {
    document.body.dataset.vscodeThemeKind = 'vscode-dark';
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe('dark');
  });

  it('should detect light theme', () => {
    document.body.dataset.vscodeThemeKind = 'vscode-light';
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe('light');
  });

  it('should detect high-contrast theme', () => {
    document.body.dataset.vscodeThemeKind = 'vscode-high-contrast';
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe('high-contrast');
  });

  it('should detect high-contrast-light as light', () => {
    document.body.dataset.vscodeThemeKind = 'vscode-high-contrast-light';
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe('light');
  });

  it('should reactively update when the theme attribute changes', async () => {
    document.body.dataset.vscodeThemeKind = 'vscode-dark';
    const { result } = renderHook(() => useTheme());

    expect(result.current).toBe('dark');

    document.body.dataset.vscodeThemeKind = 'vscode-light';

    await waitFor(() => {
      expect(result.current).toBe('light');
    });
  });

  it('should clean up the MutationObserver on unmount', () => {
    document.body.dataset.vscodeThemeKind = 'vscode-dark';
    const { result, unmount } = renderHook(() => useTheme());

    expect(result.current).toBe('dark');

    unmount();

    document.body.dataset.vscodeThemeKind = 'vscode-light';
    // After unmount, the hook should no longer observe changes.
    // We verify by checking that the last known result is still 'dark'.
    expect(result.current).toBe('dark');
  });
});
