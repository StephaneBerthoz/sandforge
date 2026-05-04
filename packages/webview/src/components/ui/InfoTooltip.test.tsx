import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { InfoTooltip, isDismissed, resetAllTooltips } from './InfoTooltip';

const STORAGE_KEY = 'sf-dismissed-tooltips';

/* Mock localStorage since jsdom may not provide clear() */
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      delete store[key];
    },
    reset: (): void => {
      store = {};
    },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

describe('InfoTooltip', () => {
  beforeEach(() => {
    localStorageMock.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should render the info icon when not dismissed', () => {
    render(<InfoTooltip id="test.tip" content="Help text" />);
    expect(screen.getByTestId('info-tooltip-test.tip')).toBeDefined();
  });

  it('should show tooltip content on hover', () => {
    render(<InfoTooltip id="test.hover" content="Hover help" />);
    const icon = screen.getByTestId('info-tooltip-test.hover');
    fireEvent.mouseEnter(icon.closest('span')!);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole('tooltip')).toBeDefined();
    expect(screen.getByText('Hover help')).toBeDefined();
  });

  it('should return null after dismiss click', () => {
    render(<InfoTooltip id="test.dismiss" content="Dismiss me" />);
    const icon = screen.getByTestId('info-tooltip-test.dismiss');

    // Show tooltip first
    fireEvent.mouseEnter(icon.closest('span')!);
    act(() => {
      vi.advanceTimersByTime(400);
    });

    // Click dismiss
    const dismissBtn = screen.getByTestId('tooltip-dismiss');
    fireEvent.click(dismissBtn);

    // Icon should be gone
    expect(screen.queryByTestId('info-tooltip-test.dismiss')).toBeNull();

    // Should be persisted in localStorage
    const stored = JSON.parse(localStorageMock.getItem(STORAGE_KEY) ?? '[]');
    expect(stored).toContain('test.dismiss');
  });

  it('should not render when already dismissed in localStorage', () => {
    localStorageMock.setItem(STORAGE_KEY, JSON.stringify(['already.dismissed']));
    render(<InfoTooltip id="already.dismissed" content="Should not show" />);
    expect(screen.queryByTestId('info-tooltip-already.dismissed')).toBeNull();
  });

  it('should track isDismissed correctly', () => {
    expect(isDismissed('some.id')).toBe(false);
    localStorageMock.setItem(STORAGE_KEY, JSON.stringify(['some.id']));
    expect(isDismissed('some.id')).toBe(true);
    expect(isDismissed('other.id')).toBe(false);
  });

  it('should clear all dismissed IDs with resetAllTooltips', () => {
    localStorageMock.setItem(STORAGE_KEY, JSON.stringify(['a', 'b', 'c']));
    expect(isDismissed('a')).toBe(true);

    resetAllTooltips();

    expect(isDismissed('a')).toBe(false);
    expect(localStorageMock.getItem(STORAGE_KEY)).toBeNull();
  });

  it('should handle corrupted localStorage gracefully', () => {
    localStorageMock.setItem(STORAGE_KEY, 'not-valid-json');
    render(<InfoTooltip id="test.corrupt" content="Still works" />);
    expect(screen.getByTestId('info-tooltip-test.corrupt')).toBeDefined();
  });
});
