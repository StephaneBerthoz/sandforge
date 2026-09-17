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
});
