import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { PanelOverlay } from './PanelOverlay';

describe('PanelOverlay', () => {
  it('draws the panel alone while the dashboard is not reading', () => {
    const { container } = render(
      <PanelOverlay isRefreshing={false}>
        <p>Governor Limits</p>
      </PanelOverlay>,
    );

    expect(screen.getByText('Governor Limits')).toBeDefined();
    expect(screen.queryByTestId('panel-overlay')).toBeNull();
    expect((container.firstChild as HTMLElement).getAttribute('aria-busy')).toBeNull();
  });

  it('keeps the panel drawn while it reads, busy, with a named bar that lays nothing over it', () => {
    const { container } = render(
      <PanelOverlay isRefreshing>
        <p>Governor Limits</p>
      </PanelOverlay>,
    );

    expect((container.firstChild as HTMLElement).getAttribute('aria-busy')).toBe('true');
    const overlay = screen.getByTestId('panel-overlay');
    expect(screen.getByRole('progressbar', { name: 'Loading...' })).toBeDefined();
    // Along the top edge only, and through to the panel under it: no veil
    // across the panel, which halved the contrast of every word under it.
    expect(overlay.className).toContain('top-0');
    expect(overlay.className).toContain('pointer-events-none');
    expect(overlay.className).not.toMatch(/\binset-0\b|\bbg-/);
  });
});
