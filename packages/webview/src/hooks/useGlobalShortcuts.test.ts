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

  // ── Existing G+key chord tests ──

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

  // ── Ctrl+N direct module navigation ──

  it('navigates to monitor on Ctrl+1', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('monitor');
  });

  it('navigates to seed on Ctrl+2', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('seed');
  });

  it('navigates to sync on Ctrl+3', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('sync');
  });

  it('navigates to compare on Ctrl+4', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '4', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('compare');
  });

  it('navigates to dataops on Ctrl+5', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('dataops');
  });

  it('navigates to automation on Ctrl+6', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '6', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('automation');
  });

  it('ignores Ctrl+N shortcuts when focus is in input', () => {
    renderHook(() => useGlobalShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }));
    expect(useAppStore.getState().currentRoute).toBe('home');
    document.body.removeChild(input);
  });

  // ── Ctrl+Enter execute ──

  it('dispatches sandforge:execute on Ctrl+Enter', () => {
    renderHook(() => useGlobalShortcuts());
    const handler = vi.fn();
    document.addEventListener('sandforge:execute', handler);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(handler).toHaveBeenCalledOnce();
    document.removeEventListener('sandforge:execute', handler);
  });

  it('dispatches sandforge:execute on Meta+Enter (Mac)', () => {
    renderHook(() => useGlobalShortcuts());
    const handler = vi.fn();
    document.addEventListener('sandforge:execute', handler);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    expect(handler).toHaveBeenCalledOnce();
    document.removeEventListener('sandforge:execute', handler);
  });

  // ── Escape cancel ──

  it('dispatches sandforge:cancel on Escape', () => {
    renderHook(() => useGlobalShortcuts());
    const handler = vi.fn();
    document.addEventListener('sandforge:cancel', handler);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(handler).toHaveBeenCalledOnce();
    document.removeEventListener('sandforge:cancel', handler);
  });
});
