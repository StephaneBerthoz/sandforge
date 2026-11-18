import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import i18n from '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import { useOrgStore } from '../../stores/useOrgStore';
import { RecoveryPage } from './RecoveryPage';

const uat: SalesforceOrg = {
  id: 'org-uat',
  alias: 'UAT',
  username: 'admin@acme.test.uat',
  instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
  orgId: '00Dxx0000001XyZ',
  orgType: 'Sandbox',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#4a9eff', icon: '', position: 0 },
  metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
  status: 'connected',
  lastConnected: '2026-11-18T08:00:00.000Z',
  tags: [],
};

afterEach(async () => {
  useOrgStore.setState({ orgs: [], selectedOrgId: null });
  await i18n.changeLanguage('en');
});

describe('RecoveryPage', () => {
  it('is titled after the sandbox it brings back into service', () => {
    useOrgStore.setState({ orgs: [uat], selectedOrgId: 'org-uat' });
    render(<RecoveryPage />);

    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading').textContent).toBe(
      en.recovery.title.replace('{{alias}}', 'UAT'),
    );
  });

  it('is titled by its name in the navigation while no org is selected', () => {
    render(<RecoveryPage />);
    expect(within(screen.getByTestId('page-header')).getByRole('heading').textContent).toBe(
      en.nav.recovery,
    );
  });

  it('says what it will list, and lists nothing yet', () => {
    useOrgStore.setState({ orgs: [uat], selectedOrgId: 'org-uat' });
    render(<RecoveryPage />);

    const page = screen.getByTestId('recovery-page');
    expect(within(page).getByText(en.recovery.emptyTitle)).toBeDefined();
    expect(within(page).getByText(en.recovery.emptyDesc)).toBeDefined();
    expect(within(page).queryAllByRole('button')).toEqual([]);
  });

  it('speaks the language of the panel', async () => {
    useOrgStore.setState({ orgs: [uat], selectedOrgId: 'org-uat' });
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    render(<RecoveryPage />);

    expect(within(screen.getByTestId('page-header')).getByRole('heading').textContent).toBe(
      'Remettre UAT en service',
    );
    expect(screen.getByText(fr.recovery.emptyTitle)).toBeDefined();
  });
});
