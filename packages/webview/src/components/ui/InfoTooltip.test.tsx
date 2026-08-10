import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { InfoTooltip, isDismissed, resetAllTooltips } from './InfoTooltip';

const STORAGE_KEY = 'sf-dismissed-tooltips';

/* In-memory mock of the webview state persistence layer. */
const mockPersistedState = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    store,
    reset(): void {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    },
  };
});

vi.mock('../../utils/webviewStorage', () => ({
  getPersistedItem: (key: string): string | null => mockPersistedState.store[key] ?? null,
  setPersistedItem: (key: string, value: string): void => {
    mockPersistedState.store[key] = value;
  },
  removePersistedItem: (key: string): void => {
    delete mockPersistedState.store[key];
  },
}));

describe('InfoTooltip', () => {
  beforeEach(() => {
    mockPersistedState.reset();
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

    // Should be persisted in the webview state
    const stored = JSON.parse(mockPersistedState.store[STORAGE_KEY] ?? '[]');
    expect(stored).toContain('test.dismiss');
  });

  it('should not render when already dismissed in the persisted state', () => {
    mockPersistedState.store[STORAGE_KEY] = JSON.stringify(['already.dismissed']);
    render(<InfoTooltip id="already.dismissed" content="Should not show" />);
    expect(screen.queryByTestId('info-tooltip-already.dismissed')).toBeNull();
  });

  it('should track isDismissed correctly', () => {
    expect(isDismissed('some.id')).toBe(false);
    mockPersistedState.store[STORAGE_KEY] = JSON.stringify(['some.id']);
    expect(isDismissed('some.id')).toBe(true);
    expect(isDismissed('other.id')).toBe(false);
  });

  it('should clear all dismissed IDs with resetAllTooltips', () => {
    mockPersistedState.store[STORAGE_KEY] = JSON.stringify(['a', 'b', 'c']);
    expect(isDismissed('a')).toBe(true);

    resetAllTooltips();

    expect(isDismissed('a')).toBe(false);
    expect(mockPersistedState.store[STORAGE_KEY]).toBeUndefined();
  });

  it('should handle corrupted persisted state gracefully', () => {
    mockPersistedState.store[STORAGE_KEY] = 'not-valid-json';
    render(<InfoTooltip id="test.corrupt" content="Still works" />);
    expect(screen.getByTestId('info-tooltip-test.corrupt')).toBeDefined();
  });
});
