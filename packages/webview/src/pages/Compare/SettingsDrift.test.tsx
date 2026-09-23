import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { SettingsDrift } from './SettingsDrift';
import type { SettingsDriftReport } from './SettingsDrift';

const DRIFT: SettingsDriftReport = {
  items: [
    { setting: 'DefaultLocaleSidKey', sourceValue: 'en_US', targetValue: 'fr_FR', status: 'drift' },
    { setting: 'TimeZoneSidKey', sourceValue: 'UTC', targetValue: 'UTC', status: 'match' },
  ],
  totalChecked: 2,
  driftCount: 1,
  matchCount: 1,
  missingCount: 0,
  detectedAt: '2026-09-01T00:00:00Z',
};

describe('SettingsDrift', () => {
  it('names the drift score bar after the label beside it', () => {
    render(<SettingsDrift drift={DRIFT} sourceLabel="Dev" targetLabel="QA" />);
    const bar = screen.getByRole('progressbar', { name: 'Drift Score' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
  });

  it('draws a setting only the source holds as an addition, and one only the target holds as a removal', () => {
    // As the rest of the page reads them since `removed` means only the source
    // holds it: the tab called it "Removed", in red.
    render(
      <SettingsDrift
        drift={{
          ...DRIFT,
          items: [
            { setting: 'Name', sourceValue: 'Acme', targetValue: '', status: 'missing_target' },
            { setting: 'Locale', sourceValue: '', targetValue: 'fr_FR', status: 'missing_source' },
          ],
        }}
        sourceLabel="Dev"
        targetLabel="QA"
      />,
    );

    const sourceOnly = screen.getByTestId('drift-status-Name').firstElementChild as HTMLElement;
    const targetOnly = screen.getByTestId('drift-status-Locale').firstElementChild as HTMLElement;
    expect([sourceOnly.textContent, sourceOnly.classList.contains('bg-status-success')]).toEqual([
      'Only in the source',
      true,
    ]);
    expect([targetOnly.textContent, targetOnly.classList.contains('bg-status-error')]).toEqual([
      'Only in the target',
      true,
    ]);
    const counts = Array.from(screen.getByTestId('drift-summary').children).map((span) => [
      span.textContent,
      span.className,
    ]);
    expect(counts.slice(0, 2)).toEqual([
      ['+1 only in the source', 'text-status-success'],
      ['-1 only in the target', 'text-status-error'],
    ]);
  });
});
