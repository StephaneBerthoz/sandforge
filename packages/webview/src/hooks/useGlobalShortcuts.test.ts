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

  it('navigates to grappe on Ctrl+7', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '7', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('grappe');
  });

  it('navigates to autopilot on Ctrl+8', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '8', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('autopilot');
  });

  it('navigates to migration on Ctrl+9', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '9', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('migration');
  });

  it('navigates to forge on Ctrl+0', () => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true }));
    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  // ── Chords for the remaining navigation modules ──

  it.each([
    ['s', 'seed'],
    ['y', 'sync'],
    ['p', 'autopilot'],
    ['n', 'migration'],
    ['z', 'frozen'],
    ['i', 'ai'],
    ['o', 'orgs'],
    ['l', 'help'],
  ] as const)('navigates on G→%s chord to %s', (key, route) => {
    renderHook(() => useGlobalShortcuts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key }));
    expect(useAppStore.getState().currentRoute).toBe(route);
  });

  it('ignores Ctrl+N shortcuts when focus is in input', () => {
    renderHook(() => useGlobalShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }));
    expect(useAppStore.getState().currentRoute).toBe('home');
    document.body.removeChild(input);
  });

  // ── Keys that used to announce events nobody listened to ──

  // Ctrl+Enter sent `sandforge:execute` and Escape sent `sandforge:cancel`, and
  // no component ever subscribed to either: the Help page taught Ctrl+Enter as
  // "run the current action" while pressing it did nothing. Escape still closes
  // dialogs, through each dialog's own handler.
  it.each([
    ['Ctrl+Enter', { key: 'Enter', ctrlKey: true }],
    ['Meta+Enter', { key: 'Enter', metaKey: true }],
    ['Escape', { key: 'Escape' }],
  ] as const)('sends no page-wide action event on %s', (_label, init) => {
    renderHook(() => useGlobalShortcuts());
    const execute = vi.fn();
    const cancel = vi.fn();
    document.addEventListener('sandforge:execute', execute);
    document.addEventListener('sandforge:cancel', cancel);
    const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
    document.dispatchEvent(event);
    document.removeEventListener('sandforge:execute', execute);
    document.removeEventListener('sandforge:cancel', cancel);
    expect(execute).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(useAppStore.getState().currentRoute).toBe('home');
  });
});
