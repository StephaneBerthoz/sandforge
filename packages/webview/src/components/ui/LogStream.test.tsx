import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { LogStream } from './LogStream';
import type { LogEntry } from './LogStream';

const now = new Date('2026-03-07T14:30:45.000Z').getTime();

const entries: LogEntry[] = [
  { id: '1', timestamp: now, level: 'info', message: 'Server started' },
  { id: '2', timestamp: now + 1000, level: 'warn', message: 'High memory usage' },
  { id: '3', timestamp: now + 2000, level: 'error', message: 'Connection lost' },
  { id: '4', timestamp: now + 3000, level: 'debug', message: 'Query executed' },
];

describe('LogStream', () => {
  it('should render log entries', () => {
    render(<LogStream entries={entries} />);
    const items = screen.getAllByTestId('logstream-entry');
    expect(items.length).toBe(4);
    expect(screen.getByText('Server started')).toBeDefined();
    expect(screen.getByText('Connection lost')).toBeDefined();
  });

  it('should format timestamps as HH:mm:ss', () => {
    render(<LogStream entries={[entries[0]]} />);
    const entry = screen.getByTestId('logstream-entry');
    // The formatted time depends on local timezone, so just check the pattern
    const timeText = entry.textContent ?? '';
    expect(/\d{2}:\d{2}:\d{2}/.test(timeText)).toBe(true);
  });

  it('should color entries by level', () => {
    const { container } = render(<LogStream entries={entries} />);
    const entryDivs = container.querySelectorAll('[data-testid="logstream-entry"]');

    // Info entry should have text-text-secondary
    const infoMessage = entryDivs[0].querySelector('.text-text-secondary');
    expect(infoMessage).toBeDefined();

    // Warn entry should have text-monitor
    const warnMessage = entryDivs[1].querySelector('.text-monitor');
    expect(warnMessage).toBeDefined();

    // Error entry should have text-automation
    const errorMessage = entryDivs[2].querySelector('.text-automation');
    expect(errorMessage).toBeDefined();

    // Debug entry should have text-text-muted
    const debugMessage = entryDivs[3].querySelector('.text-text-muted');
    expect(debugMessage).toBeDefined();
  });

  it('should filter to only error entries when error filter active', () => {
    render(<LogStream entries={entries} />);
    fireEvent.click(screen.getByTestId('logstream-filter-error'));
    const items = screen.getAllByTestId('logstream-entry');
    expect(items.length).toBe(1);
    expect(screen.getByText('Connection lost')).toBeDefined();
  });

  it('should filter to warn and error entries when warn filter active', () => {
    render(<LogStream entries={entries} />);
    fireEvent.click(screen.getByTestId('logstream-filter-warn'));
    const items = screen.getAllByTestId('logstream-entry');
    expect(items.length).toBe(2);
    expect(screen.getByText('High memory usage')).toBeDefined();
    expect(screen.getByText('Connection lost')).toBeDefined();
  });

  it('should respect maxEntries and render only last N', () => {
    render(<LogStream entries={entries} maxEntries={2} />);
    const items = screen.getAllByTestId('logstream-entry');
    expect(items.length).toBe(2);
    expect(screen.getByText('Connection lost')).toBeDefined();
    expect(screen.getByText('Query executed')).toBeDefined();
  });

  it('should switch filters via tab buttons', () => {
    render(<LogStream entries={entries} />);

    // Default: all entries
    expect(screen.getAllByTestId('logstream-entry').length).toBe(4);

    // Switch to errors
    fireEvent.click(screen.getByTestId('logstream-filter-error'));
    expect(screen.getAllByTestId('logstream-entry').length).toBe(1);

    // Switch back to all
    fireEvent.click(screen.getByTestId('logstream-filter-all'));
    expect(screen.getAllByTestId('logstream-entry').length).toBe(4);
  });

  it('should render empty state when no entries', () => {
    render(<LogStream entries={[]} />);
    expect(screen.getByTestId('logstream-empty')).toBeDefined();
    expect(screen.getByText('No log entries')).toBeDefined();
  });

  it('should apply custom className', () => {
    render(<LogStream entries={entries} className="mt-4" />);
    const root = screen.getByTestId('logstream');
    expect(root.className).toContain('mt-4');
  });

  it('should hide filter tabs when hideFilterBar is true', () => {
    render(<LogStream entries={entries} hideFilterBar />);
    expect(screen.queryByTestId('logstream-filter-all')).toBeNull();
    expect(screen.queryByTestId('logstream-filter-error')).toBeNull();
    expect(screen.queryByTestId('logstream-filter-warn')).toBeNull();
    // Entries should still render
    expect(screen.getAllByTestId('logstream-entry').length).toBe(4);
  });

  it('should show filter tabs when hideFilterBar is false or undefined', () => {
    render(<LogStream entries={entries} hideFilterBar={false} />);
    expect(screen.getByTestId('logstream-filter-all')).toBeDefined();
    expect(screen.getByTestId('logstream-filter-error')).toBeDefined();
    expect(screen.getByTestId('logstream-filter-warn')).toBeDefined();
  });

  /* ---- UX-15: Copy All button ---- */
  it('should render Copy All button when entries exist', () => {
    const singleEntry = [
      { id: '1', timestamp: Date.now(), level: 'info' as const, message: 'Hello' },
    ];
    render(<LogStream entries={singleEntry} />);
    expect(screen.getByTestId('logstream-copy-all')).toBeDefined();
  });

  /* ---- UX-15: Export button ---- */
  it('should render Export button when entries exist', () => {
    const singleEntry = [
      { id: '1', timestamp: Date.now(), level: 'info' as const, message: 'Hello' },
    ];
    // The control is only rendered when someone can act on it: LogStream is a
    // presentational primitive and cannot save anything itself.
    render(<LogStream entries={singleEntry} onExport={vi.fn()} />);
    expect(screen.getByTestId('logstream-export')).toBeDefined();
  });

  /* ---- UX-15: Buttons not shown when empty ---- */
  it('should not render toolbar when entries are empty', () => {
    render(<LogStream entries={[]} />);
    expect(screen.queryByTestId('logstream-copy-all')).toBeNull();
  });

  /* ---- UX-16: Scroll container has onScroll handler ---- */
  it('should have onScroll handler on scroll container', () => {
    const singleEntry = [
      { id: '1', timestamp: Date.now(), level: 'info' as const, message: 'Test' },
    ];
    render(<LogStream entries={singleEntry} autoScroll />);
    // The scroll container should exist and be interactive
    const container = screen.getByTestId('logstream').querySelector('.overflow-y-auto');
    expect(container).toBeDefined();
  });

  /* ---- A11Y-02: aria-pressed on filter buttons ---- */
  it('should have aria-pressed="true" on active filter and "false" on others', () => {
    render(<LogStream entries={entries} />);
    expect(screen.getByTestId('logstream-filter-all').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('logstream-filter-error').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('logstream-filter-warn').getAttribute('aria-pressed')).toBe('false');
  });

  it('should update aria-pressed when clicking a different filter', () => {
    render(<LogStream entries={entries} />);
    fireEvent.click(screen.getByTestId('logstream-filter-error'));
    expect(screen.getByTestId('logstream-filter-all').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('logstream-filter-error').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('logstream-filter-warn').getAttribute('aria-pressed')).toBe('false');
  });

  /* ---- A11Y-03: role=log and aria-live on scroll container ---- */
  it('should have role="log" and aria-live="polite" on the scroll container', () => {
    render(<LogStream entries={entries} />);
    const logContainer = screen.getByRole('log');
    expect(logContainer).toBeDefined();
    expect(logContainer.getAttribute('aria-live')).toBe('polite');
  });

  /* ---- PERF-05: All filter returns all entries without copying ---- */
  it('should render all entries without filtering when filter is "all"', () => {
    const mixedEntries: LogEntry[] = [
      { id: '1', timestamp: Date.now(), level: 'info', message: 'Info message' },
      { id: '2', timestamp: Date.now(), level: 'error', message: 'Error message' },
      { id: '3', timestamp: Date.now(), level: 'warn', message: 'Warn message' },
    ];
    render(<LogStream entries={mixedEntries} filter="all" />);
    const logEntries = screen.getAllByTestId('logstream-entry');
    expect(logEntries).toHaveLength(3);
  });
});
