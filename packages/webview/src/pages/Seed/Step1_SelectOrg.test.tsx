import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { Step1SelectOrg } from './Step1_SelectOrg';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-2',
    alias: 'prod',
    username: 'user@prod.com',
    instanceUrl: 'https://prod.salesforce.com',
    orgId: '00D000000000002',
    orgType: 'Production',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.CRITICAL,
    appearance: { color: '#c23934', icon: 'cloud', position: 1 },
    metadata: { apiVersion: '59.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

describe('Step1SelectOrg', () => {
  it('should render the org select', () => {
    render(<Step1SelectOrg orgs={mockOrgs} selectedOrgId="" onSelect={vi.fn()} />);
    expect(screen.getByTestId('step-select-org')).toBeDefined();
  });

  it('should display org options with type badges', () => {
    render(<Step1SelectOrg orgs={mockOrgs} selectedOrgId="" onSelect={vi.fn()} />);
    expect(screen.getByText('dev1 [SBX]')).toBeDefined();
    expect(screen.getByText('prod [PROD]')).toBeDefined();
  });

  it('should call onSelect when an org is selected', () => {
    const onSelect = vi.fn();
    render(<Step1SelectOrg orgs={mockOrgs} selectedOrgId="" onSelect={onSelect} />);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'org-2' } });
    expect(onSelect).toHaveBeenCalledWith('org-2');
  });

  it('should show description text', () => {
    render(<Step1SelectOrg orgs={mockOrgs} selectedOrgId="" onSelect={vi.fn()} />);
    expect(screen.getByText('Choose the org where data will be seeded')).toBeDefined();
  });

  it('should use alias as label when available', () => {
    render(<Step1SelectOrg orgs={mockOrgs} selectedOrgId="" onSelect={vi.fn()} />);
    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels).toContain('dev1 [SBX]');
    expect(labels).toContain('prod [PROD]');
  });
});
