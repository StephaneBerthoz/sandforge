import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not show tooltip initially', () => {
    render(
      <Tooltip content="Help text">
        <button>Hover me</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('should show tooltip after hover delay', () => {
    render(
      <Tooltip content="Help text">
        <button>Hover me</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByText('Hover me').parentElement!);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeDefined();
    expect(screen.getByText('Help text')).toBeDefined();
  });

  it('should hide tooltip on mouse leave', () => {
    render(
      <Tooltip content="Help text">
        <button>Hover me</button>
      </Tooltip>,
    );
    const wrapper = screen.getByText('Hover me').parentElement!;
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeDefined();
    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('should render with bottom positioning', () => {
    render(
      <Tooltip content="Bottom tip" side="bottom">
        <button>Hover me</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByText('Hover me').parentElement!);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.className).toContain('top-full');
  });

  it('should show tooltip on focus', () => {
    render(
      <Tooltip content="Focus tip">
        <button>Focus me</button>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText('Focus me').parentElement!);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeDefined();
  });
});
