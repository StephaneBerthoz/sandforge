import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { SalesforceOrg } from '@sandforge/shared';
import '../../i18n';
import { OrgRibbon } from './OrgRibbon';

function org(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'dev@example.com',
    instanceUrl: 'https://dev.example.my.salesforce.com/',
    orgType: 'Sandbox',
    status: 'connected',
    tags: [],
    ...overrides,
  } as SalesforceOrg;
}

const QA = org({
  id: 'org-2',
  alias: 'QASandbox',
  username: 'qa@example.com',
  instanceUrl: 'https://qa.example.my.salesforce.com',
});
const PROD = org({
  id: 'org-3',
  alias: 'Live',
  username: 'live@example.com',
  orgType: 'Production',
  instanceUrl: 'https://live.example.my.salesforce.com',
});

describe('OrgRibbon', () => {
  it('says where the run copies from and where it writes, each org with its type and instance', () => {
    render(<OrgRibbon source={org()} target={QA} />);
    const source = within(screen.getByTestId('org-ribbon-source'));
    const target = within(screen.getByTestId('org-ribbon-target'));

    expect(source.getByText('Copied from')).toBeDefined();
    expect(source.getByTestId('org-ribbon-source-name').textContent).toBe('DevSandbox');
    expect(source.getByTestId('org-badge-type').textContent).toBe('SANDBOX');
    expect(source.getByTestId('org-ribbon-source-url').textContent).toBe(
      'dev.example.my.salesforce.com',
    );
    expect(target.getByText('Written into')).toBeDefined();
    expect(target.getByTestId('org-ribbon-target-name').textContent).toBe('QASandbox');
  });

  it('names an org by its username when it has no alias, never by the id the store keys it on', () => {
    render(<OrgRibbon source={org({ alias: '' })} target={QA} />);
    expect(screen.getByTestId('org-ribbon-source-name').textContent).toBe('dev@example.com');
    expect(screen.getByTestId('org-ribbon').textContent).not.toContain('org-1');
  });

  it('tells the target from the source by more than a colour', () => {
    render(<OrgRibbon source={org()} target={QA} />);
    expect(screen.getByTestId('org-ribbon-target').className).toContain('border-2');
    expect(screen.getByTestId('org-ribbon-source').className).not.toContain('border-2');
    expect(screen.getByTestId('org-ribbon-target-name').className).toContain('font-semibold');
    expect(screen.getByTestId('org-ribbon-source-name').className).not.toContain('font-semibold');
  });

  it('marks a production org with a shield and the word, not with its red alone', () => {
    render(<OrgRibbon source={org()} target={PROD} />);
    const target = screen.getByTestId('org-ribbon-target');
    expect(target.getAttribute('data-production')).toBe('true');
    expect(within(target).getByTestId('org-ribbon-target-production').textContent).toBe(
      'Production org',
    );
    expect(target.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('org-ribbon-source').getAttribute('data-production')).toBeNull();
    expect(screen.queryByTestId('org-ribbon-source-production')).toBeNull();
  });

  it('marks a production source as well: a read of it is still a read of production', () => {
    render(<OrgRibbon source={PROD} target={QA} />);
    expect(screen.getByTestId('org-ribbon-source-production')).toBeDefined();
  });

  it('does not take a Developer Edition an earlier build registered as production for one', () => {
    const developer = org({
      orgType: 'Production',
      metadata: { edition: 'Developer Edition' },
    } as Partial<SalesforceOrg>);
    render(<OrgRibbon source={developer} target={QA} />);
    expect(screen.getByTestId('org-ribbon-source').getAttribute('data-production')).toBeNull();
  });

  it('says a session that is no longer connected', () => {
    render(<OrgRibbon source={org({ status: 'expired' })} target={QA} />);
    expect(screen.getByTestId('org-ribbon-source-status').textContent).toBe('Session Expired');
    expect(screen.queryByTestId('org-ribbon-target-status')).toBeNull();
  });

  it('takes a name alone for an org this machine does not hold, and says a side not chosen', () => {
    render(<OrgRibbon kind="load" source="Frozen source" target={undefined} />);
    expect(screen.getByText('Frozen from')).toBeDefined();
    expect(screen.getByTestId('org-ribbon-source-name').textContent).toBe('Frozen source');
    expect(screen.getByTestId('org-ribbon-target-name').textContent).toBe('Not chosen');
    expect(screen.queryByTestId('org-badge-type')).toBeNull();
  });

  it('calls the sides source and target on a page that compares and writes nothing', () => {
    render(<OrgRibbon kind="compare" source={org()} target={QA} />);
    expect(screen.getByText('Source')).toBeDefined();
    expect(screen.getByText('Target')).toBeDefined();
    expect(screen.queryByText('Written into')).toBeNull();
  });

  it('is one group, named for a screen reader', () => {
    render(<OrgRibbon source={org()} target={QA} />);
    expect(screen.getByRole('group', { name: 'The orgs of this run' })).toBeDefined();
  });
});
