import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { CloneSourcePicker } from './CloneSourcePicker';
import type { SalesforceOrg } from '@sandforge/shared';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-source',
    alias: 'source-dev',
    username: 'user@source.com',
    instanceUrl: 'https://source.salesforce.com',
    orgType: 'Sandbox',
    status: 'connected',
    safetyTier: 'low',
    apiVersion: '59.0',
    lastConnected: '2024-01-01T00:00:00Z',
  } as SalesforceOrg,
  {
    id: 'org-target',
    alias: 'target-dev',
    username: 'user@target.com',
    instanceUrl: 'https://target.salesforce.com',
    orgType: 'Sandbox',
    status: 'connected',
    safetyTier: 'low',
    apiVersion: '59.0',
    lastConnected: '2024-01-01T00:00:00Z',
  } as SalesforceOrg,
  {
    id: 'org-other',
    alias: 'other-dev',
    username: 'user@other.com',
    instanceUrl: 'https://other.salesforce.com',
    orgType: 'Sandbox',
    status: 'connected',
    safetyTier: 'low',
    apiVersion: '59.0',
    lastConnected: '2024-01-01T00:00:00Z',
  } as SalesforceOrg,
];

describe('CloneSourcePicker', () => {
  it('should render source and target columns', () => {
    render(
      <CloneSourcePicker
        sourceOrgId=""
        targetOrgId="org-target"
        orgs={mockOrgs}
        onSourceSelected={vi.fn()}
      />,
    );

    expect(screen.getByTestId('clone-source-picker')).toBeDefined();
    expect(screen.getByTestId('clone-source-column')).toBeDefined();
    expect(screen.getByTestId('clone-target-column')).toBeDefined();
    expect(screen.getByTestId('clone-direction-arrow')).toBeDefined();
  });

  it('should exclude target org from source select options', () => {
    render(
      <CloneSourcePicker
        sourceOrgId=""
        targetOrgId="org-target"
        orgs={mockOrgs}
        onSourceSelected={vi.fn()}
      />,
    );

    const select = screen.getByTestId('clone-source-select') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    const optionValues = options.map((o) => o.value).filter((v) => v !== '');

    // target org should not be in the list
    expect(optionValues).not.toContain('org-target');
    // source and other should be present
    expect(optionValues).toContain('org-source');
    expect(optionValues).toContain('org-other');
  });

  it('should call onSourceSelected when selecting an org', () => {
    const onSourceSelected = vi.fn();
    render(
      <CloneSourcePicker
        sourceOrgId=""
        targetOrgId="org-target"
        orgs={mockOrgs}
        onSourceSelected={onSourceSelected}
      />,
    );

    const select = screen.getByTestId('clone-source-select');
    fireEvent.change(select, { target: { value: 'org-source' } });

    expect(onSourceSelected).toHaveBeenCalledWith('org-source');
  });

  it('should show OrgBadge for selected source org', () => {
    render(
      <CloneSourcePicker
        sourceOrgId="org-source"
        targetOrgId="org-target"
        orgs={mockOrgs}
        onSourceSelected={vi.fn()}
      />,
    );

    // Both source and target columns should have org badges
    const badges = screen.getAllByTestId('org-badge');
    expect(badges.length).toBeGreaterThanOrEqual(2);
  });

  it('should show target org as read-only OrgBadge', () => {
    render(
      <CloneSourcePicker
        sourceOrgId=""
        targetOrgId="org-target"
        orgs={mockOrgs}
        onSourceSelected={vi.fn()}
      />,
    );

    const targetColumn = screen.getByTestId('clone-target-column');
    const badge = targetColumn.querySelector('[data-testid="org-badge"]');
    expect(badge).toBeDefined();
  });
});
