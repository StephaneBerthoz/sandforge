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

describe('OrgDropdown with an org listed but not offered', () => {
  /** The dropdown open, `org-1` unavailable with a note, `onChange` spied. */
  function openWithUnavailable(onChange = vi.fn()) {
    render(
      <OrgDropdown
        value=""
        onChange={onChange}
        orgs={mockOrgs}
        ariaLabel="Target Org"
        testId="test-dd"
        unavailable={{ orgId: 'org-1', note: '(source of this dataset)' }}
      />,
    );
    fireEvent.click(screen.getByTestId('test-dd'));
    return onChange;
  }

  // The org a Frozen dataset was extracted from was offered as a target, and
  // the first load refused in English.
  it('lists it disabled, with why beside its name, and a click picks nothing', () => {
    const onChange = openWithUnavailable();

    const option = screen.getByTestId('test-dd-option-org-1') as HTMLButtonElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain('DevOrg');
    expect(screen.getByTestId('test-dd-option-org-1-note').textContent).toBe(
      '(source of this dataset)',
    );
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getByTestId('test-dd-option-org-2') as HTMLButtonElement).disabled).toBe(false);
  });

  it('walks the arrows over it', () => {
    openWithUnavailable();
    const panel = screen.getByTestId('test-dd-panel');
    const empty = screen.getByTestId('test-dd-option-empty');
    empty.focus();

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('test-dd-option-org-2'));
    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(empty);
  });

  it('offers every org as before when none is named', () => {
    render(
      <OrgDropdown value="" onChange={vi.fn()} orgs={mockOrgs} ariaLabel="Org" testId="test-dd" />,
    );
    fireEvent.click(screen.getByTestId('test-dd'));
    for (const id of ['org-1', 'org-2']) {
      expect((screen.getByTestId(`test-dd-option-${id}`) as HTMLButtonElement).disabled).toBe(
        false,
      );
    }
    expect(screen.queryByTestId('test-dd-option-org-1-note')).toBeNull();
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

  it('opens its panel from its right edge, as wide as what it lists and no wider than the room to its left', () => {
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
    // A picker in a page's header: narrow, at the right of the page. Its
    // panel took the trigger's width, and cut the names down to "De…".
    trigger.getBoundingClientRect = () =>
      ({ left: 1120, right: 1264, width: 144, top: 30, bottom: 50, height: 20 }) as DOMRect;
    fireEvent.click(trigger);
    const panel = screen.getByTestId('test-dd-panel');
    const classes = panel.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['right-0', 'w-max', 'min-w-full']));
    expect(classes).not.toContain('left-0');
    expect(panel.style.maxWidth).toBe('1256px');
  });

  it('marks a sandbox marked Staging, in its panel and once picked, when asked to', () => {
    const staging: SalesforceOrg = {
      ...mockOrgs[0],
      id: 'org-uat',
      alias: 'UAT',
      username: 'qa@test.com.uat',
      staging: true,
    };
    const { rerender } = render(
      <OrgDropdown
        value=""
        onChange={vi.fn()}
        orgs={[mockOrgs[0], staging]}
        ariaLabel="Org to replay into"
        testId="test-dd"
        showStaging
      />,
    );
    fireEvent.click(screen.getByTestId('test-dd'));
    expect(screen.getByTestId('test-dd-option-org-uat-staging').textContent).toBe('STAGING');
    expect(screen.getByTestId('test-dd-option-org-uat').textContent).toContain('STAGING');
    expect(screen.queryByTestId('test-dd-option-org-1-staging')).toBeNull();

    rerender(
      <OrgDropdown
        value="org-uat"
        onChange={vi.fn()}
        orgs={[mockOrgs[0], staging]}
        ariaLabel="Org to replay into"
        testId="test-dd"
        showStaging
      />,
    );
    expect(screen.getByTestId('test-dd-staging').textContent).toBe('STAGING');
    expect(screen.getByTestId('test-dd').getAttribute('aria-label')).toBe(
      'Org to replay into: UAT (STAGING), status: Connected',
    );

    // Unasked, a picker says nothing of the mark, as before.
    rerender(
      <OrgDropdown
        value="org-uat"
        onChange={vi.fn()}
        orgs={[mockOrgs[0], staging]}
        ariaLabel="Org to replay into"
        testId="test-dd"
      />,
    );
    expect(screen.queryByTestId('test-dd-staging')).toBeNull();
  });
});
