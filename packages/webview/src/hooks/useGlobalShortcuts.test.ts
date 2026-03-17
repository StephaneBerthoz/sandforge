import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import { useAppStore } from '../stores/useAppStore';

describe('useGlobalShortcuts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState({ currentRoute: 'home' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('navigates on G→H chord', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }));
    expect(useAppStore.getState().currentRoute).toBe('home');
  });

  it('navigates on G→M chord to monitor', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    expect(useAppStore.getState().currentRoute).toBe('monitor');
  });

  it('navigates on G→F chord to forge', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  it('does not navigate if chord times out', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
    vi.advanceTimersByTime(600);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    expect(useAppStore.getState().currentRoute).toBe('home');
  });

  it('ignores chord in input elements', () => {
    renderHook(() => useGlobalShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    expect(useAppStore.getState().currentRoute).toBe('home');
    document.body.removeChild(input);
  });

  it('ignores G key with ctrl modifier', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    expect(useAppStore.getState().currentRoute).toBe('home');
  });
});
