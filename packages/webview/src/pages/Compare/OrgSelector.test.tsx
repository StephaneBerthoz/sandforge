import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSelector } from './OrgSelector';
import { OrgSafetyTier } from '@sandforge/shared';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'DevOrg',
    username: 'dev@test.com',
    instanceUrl: 'https://dev.salesforce.com',
    orgId: 'oid-1',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-2',
    alias: 'ProdOrg',
    username: 'prod@test.com',
    instanceUrl: 'https://prod.salesforce.com',
    orgId: 'oid-2',
    orgType: 'Production',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.CRITICAL,
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

describe('OrgSelector', () => {
  const defaultProps = {
    orgs: mockOrgs,
    sourceOrgId: '',
    targetOrgId: '',
    onSourceChange: vi.fn(),
    onTargetChange: vi.fn(),
  };

  it('should render the org selector', () => {
    render(<OrgSelector {...defaultProps} />);
    expect(screen.getByTestId('org-selector')).toBeDefined();
  });

  it('should render source and target labels', () => {
    render(<OrgSelector {...defaultProps} />);
    expect(screen.getByText('Source Org')).toBeDefined();
    expect(screen.getByText('Target Org')).toBeDefined();
  });

  it('should show org type badges in options', () => {
    render(<OrgSelector {...defaultProps} />);
    expect(screen.getAllByText(/DevOrg \[SBX\]/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ProdOrg \[PROD\]/).length).toBeGreaterThan(0);
  });

  it('should call onSourceChange when source is selected', () => {
    const handler = vi.fn();
    render(<OrgSelector {...defaultProps} onSourceChange={handler} />);
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'org-1' } });
    expect(handler).toHaveBeenCalledWith('org-1');
  });

  it('should call onTargetChange when target is selected', () => {
    const handler = vi.fn();
    render(<OrgSelector {...defaultProps} onTargetChange={handler} />);
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: 'org-2' } });
    expect(handler).toHaveBeenCalledWith('org-2');
  });

  it('should accept custom className', () => {
    render(<OrgSelector {...defaultProps} className="my-class" />);
    expect(screen.getByTestId('org-selector').className).toContain('my-class');
  });

  it('should show selected source org', () => {
    render(<OrgSelector {...defaultProps} sourceOrgId="org-1" />);
    const selects = screen.getAllByRole('combobox');
    expect((selects[0] as HTMLSelectElement).value).toBe('org-1');
  });

  it('should show same org warning when source equals target', () => {
    render(<OrgSelector {...defaultProps} sourceOrgId="org-1" targetOrgId="org-1" />);
    expect(screen.getByTestId('org-same-warning')).toBeDefined();
    expect(screen.getByText('Source and target orgs must be different')).toBeDefined();
  });

  it('should not show same org warning when orgs differ', () => {
    render(<OrgSelector {...defaultProps} sourceOrgId="org-1" targetOrgId="org-2" />);
    expect(screen.queryByTestId('org-same-warning')).toBeNull();
  });
});
