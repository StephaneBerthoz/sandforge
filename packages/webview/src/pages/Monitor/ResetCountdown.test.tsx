import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../../i18n';
import { ResetCountdown } from './ResetCountdown';

describe('ResetCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders with data-testid reset-countdown', () => {
    render(<ResetCountdown />);
    expect(screen.getByTestId('reset-countdown')).toBeDefined();
  });

  it('displays time in HH:MM:SS format', () => {
    render(<ResetCountdown />);
    const value = screen.getByTestId('reset-countdown-value').textContent ?? '';
    expect(value).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('shows Reset in label', () => {
    render(<ResetCountdown />);
    expect(screen.getByText('Reset in')).toBeDefined();
  });

  it('countdown value changes after 1 second', () => {
    render(<ResetCountdown />);
    const initial = screen.getByTestId('reset-countdown-value').textContent;

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const after = screen.getByTestId('reset-countdown-value').textContent;
    expect(after).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(initial).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('countdown does not display negative values', () => {
    render(<ResetCountdown />);

    // Advance past midnight boundary
    act(() => {
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    });

    const value = screen.getByTestId('reset-countdown-value').textContent ?? '';
    expect(value).toMatch(/\d{2}:\d{2}:\d{2}/);
    // Should not contain a minus sign
    expect(value).not.toContain('-');
  });
});
