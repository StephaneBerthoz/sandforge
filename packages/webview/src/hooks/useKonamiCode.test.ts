import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKonamiCode } from './useKonamiCode';

/** Simulates a keydown event with the given key code. */
function pressKey(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }));
}

/** The full Konami Code sequence. */
const KONAMI = [
  'ArrowUp', 'ArrowUp',
  'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight',
  'ArrowLeft', 'ArrowRight',
  'KeyB', 'KeyA',
];

/** Presses each key in the sequence, wrapping each in act() so React state updates are processed. */
function enterSequence(keys: string[]): void {
  for (const code of keys) {
    act(() => {
      pressKey(code);
    });
  }
}

describe('useKonamiCode', () => {
  let callback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callback = vi.fn();
  });

  it('should call callback when the full Konami Code is entered', () => {
    renderHook(() => useKonamiCode(callback));
    enterSequence(KONAMI);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('should not call callback for a partial sequence', () => {
    renderHook(() => useKonamiCode(callback));
    enterSequence(['ArrowUp', 'ArrowUp', 'ArrowDown']);
    expect(callback).not.toHaveBeenCalled();
  });

  it('should reset on wrong key and still detect the full sequence after', () => {
    renderHook(() => useKonamiCode(callback));
    enterSequence(['ArrowUp', 'ArrowUp', 'KeyX']);
    expect(callback).not.toHaveBeenCalled();

    enterSequence(KONAMI);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('should allow the sequence to be entered multiple times', () => {
    renderHook(() => useKonamiCode(callback));
    enterSequence(KONAMI);
    enterSequence(KONAMI);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('should clean up the event listener on unmount', () => {
    const spy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useKonamiCode(callback));
    unmount();
    expect(spy).toHaveBeenCalledWith('keydown', expect.any(Function));
    spy.mockRestore();
  });
});
