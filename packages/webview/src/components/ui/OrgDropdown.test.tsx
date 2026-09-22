import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgDropdown } from './OrgDropdown';
import type { SalesforceOrg } from '@sandforge/shared';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'DevOrg',
    username: 'dev@test.com',
    instanceUrl: 'https://dev.salesforce.com',
    orgId: 'OID1',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: 'low' as unknown as SalesforceOrg['safetyTier'],
    appearance: { color: 'blue', icon: 'default', position: 0 },
    metadata: { apiVersion: '58.0', edition: 'Developer', features: [] },
    status: 'connected',
    lastConnected: '2026-03-20T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-2',
    alias: 'ProdOrg',
    username: 'prod@test.com',
    instanceUrl: 'https://prod.salesforce.com',
    orgId: 'OID2',
    orgType: 'Production',
    authMethod: 'sfdx_import',
    safetyTier: 'critical' as unknown as SalesforceOrg['safetyTier'],
    appearance: { color: 'red', icon: 'default', position: 1 },
    metadata: { apiVersion: '58.0', edition: 'Enterprise', features: [] },
    status: 'expired',
    lastConnected: '2026-03-19T00:00:00Z',
    tags: [],
  },
];

describe('OrgDropdown', () => {
  it('should render placeholder when no org is selected', () => {
    render(
      <OrgDropdown
        value=""
        onChange={vi.fn()}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    const trigger = screen.getByTestId('test-dd');
    expect(trigger.textContent).toContain('Select');
  });

  it('should show selected org alias when value is set', () => {
    render(
      <OrgDropdown
        value="org-1"
        onChange={vi.fn()}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    const trigger = screen.getByTestId('test-dd');
    expect(trigger.textContent).toContain('DevOrg');
  });

  it('should open dropdown and list all orgs on click', () => {
    render(
      <OrgDropdown
        value=""
        onChange={vi.fn()}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    fireEvent.click(screen.getByTestId('test-dd'));
    expect(screen.getByTestId('test-dd-panel')).toBeDefined();
    expect(screen.getByTestId('test-dd-option-org-1')).toBeDefined();
    expect(screen.getByTestId('test-dd-option-org-2')).toBeDefined();
  });

  it('should call onChange when an org option is clicked', () => {
    const handleChange = vi.fn();
    render(
      <OrgDropdown
        value=""
        onChange={handleChange}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    fireEvent.click(screen.getByTestId('test-dd'));
    fireEvent.click(screen.getByTestId('test-dd-option-org-2'));
    expect(handleChange).toHaveBeenCalledWith('org-2');
  });

  it('should close dropdown on Escape key', () => {
    render(
      <OrgDropdown
        value=""
        onChange={vi.fn()}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    fireEvent.click(screen.getByTestId('test-dd'));
    expect(screen.getByTestId('test-dd-panel')).toBeDefined();
    fireEvent.keyDown(screen.getByTestId('test-dd').parentElement!, { key: 'Escape' });
    expect(screen.queryByTestId('test-dd-panel')).toBeNull();
  });
});

describe('OrgDropdown status without colour', () => {
  it('says the selected org and its status in the trigger name', () => {
    render(
      <OrgDropdown
        value="org-2"
        onChange={vi.fn()}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Source Org: ProdOrg, status: Session Expired' }),
    ).toBeDefined();
  });

  it('keeps the plain name while no org is selected', () => {
    render(
      <OrgDropdown
        value=""
        onChange={vi.fn()}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    expect(screen.getByRole('button', { name: 'Source Org' })).toBeDefined();
  });

  it('draws a connected org and a failing one with different shapes', () => {
    const { unmount } = render(
      <OrgDropdown
        value="org-1"
        onChange={vi.fn()}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    const connected = screen.getByTestId('test-dd-status').getAttribute('data-shape');
    unmount();
    render(
      <OrgDropdown
        value="org-2"
        onChange={vi.fn()}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    const expired = screen.getByTestId('test-dd-status').getAttribute('data-shape');
    expect(connected).toBeTruthy();
    expect(expired).toBeTruthy();
    expect(expired).not.toBe(connected);
  });

  it('draws a filled circle when connected, a ring while refreshing, a diamond otherwise', () => {
    const classesFor = (status: SalesforceOrg['status']): string[] => {
      const { unmount } = render(
        <OrgDropdown
          value="org-1"
          onChange={vi.fn()}
          orgs={[{ ...mockOrgs[0], status }]}
          ariaLabel="Source Org"
          testId="test-dd"
        />,
      );
      const classes = screen.getByTestId('test-dd-status').className.split(/\s+/);
      unmount();
      return classes;
    };

    const connected = classesFor('connected');
    expect(connected).toEqual(expect.arrayContaining(['rounded-full', 'bg-status-success']));
    expect(connected).not.toContain('rotate-45');
    expect(connected).not.toContain('border-2');

    // The ring is a stroke in a severity token, which holds 3:1 on light themes too.
    const refreshing = classesFor('refreshing');
    expect(refreshing).toEqual(
      expect.arrayContaining([
        'rounded-full',
        'border-2',
        'border-current',
        'bg-transparent',
        'text-status-warning',
      ]),
    );
    expect(refreshing).not.toContain('bg-status-warning');

    for (const status of ['expired', 'error'] as const) {
      const diamond = classesFor(status);
      expect(diamond).toContain('rotate-45');
      expect(diamond).not.toContain('rounded-full');
    }
  });

  it('gives every option its status as text as well as a shape', () => {
    render(
      <OrgDropdown
        value=""
        onChange={vi.fn()}
        orgs={mockOrgs}
        ariaLabel="Source Org"
        testId="test-dd"
      />,
    );
    fireEvent.click(screen.getByTestId('test-dd'));
    expect(screen.getByTestId('test-dd-option-org-2').textContent).toContain('Session Expired');
    expect(screen.getByTestId('test-dd-option-org-1').textContent).toContain('Connected');
  });
});
