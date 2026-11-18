import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { BUILTIN_PIPELINE_TEMPLATES } from '@sandforge/shared';
import { useAppStore } from '../../stores/useAppStore';
import {
  AfterRefreshBanner,
  RECENT_REFRESH_MS,
  RefreshRecoveryActions,
  SANDBOX_REFRESH_TEMPLATE_ID,
  recentRefreshOf,
} from './RefreshRecovery';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** A refresh noticed `ago` milliseconds before now. */
const noticed = (ago: number) => ({
  detectedAt: new Date(NOW - ago).toISOString(),
  evidence: 'connection' as const,
  previousOrganizationId: '00Dxx0000000001',
  organizationId: '00Dxx0000000002',
});

describe('recentRefreshOf', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the newest refresh noticed within the last week', () => {
    const newest = noticed(2 * DAY);
    expect(recentRefreshOf([newest, noticed(20 * DAY)])).toBe(newest);
  });

  it('is none once the newest refresh is older than a week, or there is none', () => {
    expect(recentRefreshOf([noticed(RECENT_REFRESH_MS + 1000)])).toBeUndefined();
    expect(recentRefreshOf([])).toBeUndefined();
  });

  it('is none when the date the refresh was noticed cannot be read', () => {
    expect(recentRefreshOf([{ ...noticed(DAY), detectedAt: 'not a date' }])).toBeUndefined();
  });
});

describe('the way back after a refresh', () => {
  const navigate = vi.fn();

  beforeEach(async () => {
    navigate.mockReset();
    useAppStore.setState({ navigate });
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('opens the template Automation runs after each refresh, the built-in one of that name', () => {
    const template = BUILTIN_PIPELINE_TEMPLATES.find((t) => t.id === SANDBOX_REFRESH_TEMPLATE_ID);
    expect(template?.name).toBe('Sandbox Refresh Post-Processing');
  });

  it('opens Back into service on the org shown, and Automation on the refresh template', () => {
    render(<RefreshRecoveryActions testIdPrefix="row" />);

    fireEvent.click(screen.getByTestId('row-bring-back'));
    expect(navigate).toHaveBeenLastCalledWith('recovery');

    fireEvent.click(screen.getByTestId('row-automate'));
    expect(navigate).toHaveBeenLastCalledWith('automation', {
      automationTemplateId: SANDBOX_REFRESH_TEMPLATE_ID,
    });
  });

  it('says on the banner which sandbox was refreshed and when, with both ways on', () => {
    render(
      <AfterRefreshBanner
        alias="UAT"
        refresh={{ ...noticed(0), detectedAt: new Date().toISOString() }}
      />,
    );

    const banner = screen.getByTestId('monitor-after-refresh');
    expect(banner.textContent).toContain('UAT was refreshed');
    expect(banner.textContent).toContain('what was written to it before the refresh is gone');
    expect(screen.getByTestId('monitor-after-refresh-bring-back').textContent).toBe(
      'Bring back into service…',
    );
    expect(screen.getByTestId('monitor-after-refresh-automate').textContent).toBe(
      'Automate after each refresh…',
    );
  });

  it('names both ways in French, a sandbox refresh a « rafraîchissement »', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    render(<RefreshRecoveryActions testIdPrefix="row" />);

    expect(screen.getByTestId('row-bring-back').textContent).toBe('Remettre en service…');
    expect(screen.getByTestId('row-automate').textContent).toBe(
      'Automatiser après chaque rafraîchissement…',
    );
  });
});
