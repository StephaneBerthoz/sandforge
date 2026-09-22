import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ProgressAnnouncer, ProgressBar } from './ProgressBar';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ProgressBar', () => {
  it('should render with correct aria attributes', () => {
    render(<ProgressBar value={50} ariaLabel="Upload" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('names the progressbar after its visible label', () => {
    render(<ProgressBar value={50} label="Uploading" />);
    expect(screen.getByRole('progressbar', { name: 'Uploading' })).toBeDefined();
  });

  it('points at the visible label instead of copying it', () => {
    render(<ProgressBar value={50} label="Uploading" />);
    const bar = screen.getByRole('progressbar');
    const labelId = bar.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toBe('Uploading');
    expect(bar.hasAttribute('aria-label')).toBe(false);
  });

  it('names the progressbar from ariaLabel when it has no visible label', () => {
    render(<ProgressBar value={50} ariaLabel="Pipeline progress" />);
    expect(screen.getByRole('progressbar', { name: 'Pipeline progress' })).toBeDefined();
  });

  it('takes its name from the element aria-labelledby names', () => {
    render(
      <>
        <span id="row-name">Account</span>
        <ProgressBar value={50} aria-labelledby="row-name" />
      </>,
    );
    expect(screen.getByRole('progressbar', { name: 'Account' })).toBeDefined();
  });

  it('speaks the value as a percentage, whatever the max', () => {
    render(<ProgressBar value={3} max={8} ariaLabel="Restore" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('38%');
  });

  it('speaks a caller-supplied value text', () => {
    render(<ProgressBar value={3} max={8} ariaLabel="Restore" valueText="3 of 8 objects" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('3 of 8 objects');
  });

  it('warns when it is given no name at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<ProgressBar value={50} />);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ProgressBar'));
  });

  it('does not warn when it is named', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<ProgressBar value={50} label="Uploading" />);
    render(<ProgressBar value={50} ariaLabel="Uploading" />);
    render(<ProgressBar value={50} aria-labelledby="elsewhere" />);
    expect(warn).not.toHaveBeenCalled();
  });

  it('should render label when provided', () => {
    render(<ProgressBar value={25} label="Loading..." />);
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('should show percentage when showPercent is true', () => {
    render(<ProgressBar value={75} showPercent ariaLabel="Upload" />);
    expect(screen.getByText('75%')).toBeDefined();
  });

  it('should clamp value between 0 and 100', () => {
    render(<ProgressBar value={150} ariaLabel="Upload" />);
    const bar = screen.getByRole('progressbar');
    const inner = bar.firstChild as HTMLElement;
    expect(inner.style.width).toBe('100%');
  });

  it('should handle custom max value', () => {
    render(<ProgressBar value={5} max={10} showPercent ariaLabel="Upload" />);
    expect(screen.getByText('50%')).toBeDefined();
  });

  it('should apply variant class', () => {
    render(<ProgressBar value={50} variant="success" ariaLabel="Upload" />);
    const bar = screen.getByRole('progressbar');
    const inner = bar.firstChild as HTMLElement;
    expect(inner.className).toContain('bg-status-success');
  });

  it('paints the fill in the colour a caller gives it', () => {
    render(<ProgressBar value={50} ariaLabel="Forge" barClassName="bg-forge" />);
    const inner = screen.getByRole('progressbar').firstChild as HTMLElement;
    expect(inner.className).toContain('bg-forge');
    expect(inner.className).not.toContain('progressBar-background');
  });

  it('should apply small size', () => {
    render(<ProgressBar value={50} size="sm" ariaLabel="Upload" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('h-1');
  });
});

describe('ProgressAnnouncer', () => {
  it('is a polite status region that says the first message at once', () => {
    render(<ProgressAnnouncer message="Seed progress: 5%" testId="announcer" />);
    const region = screen.getByTestId('announcer');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('Seed progress: 5%');
  });

  it('says a new value at most once per interval, and then the latest one', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ProgressAnnouncer message="Seed progress: 5%" interval={5000} testId="announcer" />,
    );
    const region = screen.getByTestId('announcer');

    rerender(<ProgressAnnouncer message="Seed progress: 6%" interval={5000} testId="announcer" />);
    rerender(<ProgressAnnouncer message="Seed progress: 7%" interval={5000} testId="announcer" />);
    expect(region.textContent).toBe('Seed progress: 5%');

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(region.textContent).toBe('Seed progress: 5%');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(region.textContent).toBe('Seed progress: 7%');
  });

  it('says an immediate message without waiting for the interval', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ProgressAnnouncer message="Seed progress: 5%" interval={5000} testId="announcer" />,
    );
    rerender(
      <ProgressAnnouncer
        message="Seed progress: 100%"
        interval={5000}
        immediate
        testId="announcer"
      />,
    );
    expect(screen.getByTestId('announcer').textContent).toBe('Seed progress: 100%');
  });
});
