import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import './i18n';

/*
 * A page whose chunk does not come: as on a remote workspace, where each
 * round of fetches is a network round trip.
 */
vi.mock('./pages/Help/HelpPage', () => new Promise(() => undefined));

import { PanelRouter } from './PanelRouter';

describe('PanelRouter, a page that takes its time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing for a moment, then that the page is loading', () => {
    // The panel stayed empty for as long as the chunks took, with nothing to
    // say it was loading.
    vi.useFakeTimers();
    render(<PanelRouter moduleId="help" />);
    const loading = screen.getByTestId('panel-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status', { name: 'Loading...' })).toBeDefined();
    expect(loading.contains(screen.getByRole('status'))).toBe(true);
  });
});
