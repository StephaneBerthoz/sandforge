import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { OrgSwitcher } from './OrgSwitcher';
import { OrgSafetyTier } from '@sandforge/shared';

const mockOrg = (id: string, status: 'connected' | 'expired' = 'connected') => ({
  id,
  alias: `org-${id}`,
  username: `user@${id}.com`,
  instanceUrl: 'https://test.salesforce.com',
  orgId: `00D${id}`,
  orgType: 'Sandbox' as const,
  authMethod: 'oauth_web' as const,
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#10B981', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status,
  lastConnected: '2024-01-01T00:00:00Z',
  tags: [],
});

describe('OrgSwitcher', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('should render with data-testid', () => {
    render(<OrgSwitcher />);
    expect(screen.getByTestId('org-switcher')).toBeDefined();
  });

  it('should show fallback text when no org is selected', () => {
    render(<OrgSwitcher />);
    // Translated key org.noOrgs resolves to "No organizations connected"
    expect(screen.getByText('No organizations connected')).toBeDefined();
  });

  it('should show selected org alias', () => {
    useOrgStore.setState({ orgs: [mockOrg('1')], selectedOrgId: '1' });
    render(<OrgSwitcher />);
    expect(screen.getByText('org-1')).toBeDefined();
  });

  it('should apply custom className', () => {
    render(<OrgSwitcher className="my-class" />);
    expect(screen.getByTestId('org-switcher').className).toContain('my-class');
  });
});
