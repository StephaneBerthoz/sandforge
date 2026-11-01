import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import i18n from '../../../i18n';
import fr from '../../../i18n/locales/fr.json';
import ja from '../../../i18n/locales/ja.json';
import { Step4Review } from './Step4_Review';
import { uiLocale } from '../../../utils/formatters';
import { useOrgStore } from '../../../stores/useOrgStore';

/** An org as the store holds it. */
function org(overrides: Partial<SalesforceOrg>): SalesforceOrg {
  return {
    id: 'org-x',
    alias: 'an-org',
    username: 'admin@example.test',
    instanceUrl: 'https://example.my.salesforce.com',
    orgId: '00D000000000001AAA',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T08:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

/** The two orgs of the review, keyed by the ids the store keeps. */
const SOURCE = org({
  id: 'org-1',
  alias: 'DevSandbox',
  instanceUrl: 'https://dev.example.my.salesforce.com',
});
const TARGET = org({
  id: 'org-2',
  alias: 'QASandbox',
  instanceUrl: 'https://qa.example.my.salesforce.com',
  staging: true,
});

beforeEach(() => {
  useOrgStore.setState({ orgs: [SOURCE, TARGET] });
});

afterEach(() => {
  useOrgStore.setState({ orgs: [] });
});

const defaultProps = {
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  selectedObjects: ['Account', 'Contact', 'Opportunity'],
  totalRecords: 20700,
  estimatedApiCalls: 414,
  estimatedDurationMin: 5,
  waves: 2,
  piiFields: 4,
  anonymizedFields: 3,
  complianceFramework: 'gdpr' as const,
  onFrameworkChange: vi.fn(),
  neutralizeContactPoints: true,
  onNeutralizeChange: vi.fn(),
  isExecuting: false,
  onExecute: vi.fn(),
};

describe('Step4_Review', () => {
  it('neutralizes emails and phone numbers unless the box is unticked', () => {
    const onNeutralizeChange = vi.fn();
    render(<Step4Review {...defaultProps} onNeutralizeChange={onNeutralizeChange} />);
    const toggle = screen.getByTestId('step4-contact-points-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);
    expect(onNeutralizeChange).toHaveBeenCalledWith(false);
  });

  it('offers, off, the box that mutes the target’s automation, read as the run starts', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Step4Review {...defaultProps} />);
    expect(screen.queryByTestId('step4-mute')).toBeNull();

    rerender(
      <Step4Review {...defaultProps} mute={{ checked: false, onChange, org: 'QA-SANDBOX' }} />,
    );
    const toggle = screen.getByTestId('step4-mute-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByTestId('step4-mute-at-start').textContent).toMatch(
      /^What it silences is read from QA-SANDBOX as the run starts/,
    );
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('keeps the compliance framework behind an Advanced disclosure, which picks another', () => {
    const onFrameworkChange = vi.fn();
    render(<Step4Review {...defaultProps} onFrameworkChange={onFrameworkChange} />);
    const advanced = screen.getByTestId('step4-compliance-advanced') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);

    fireEvent.click(screen.getByTestId('framework-hipaa'));
    expect(onFrameworkChange).toHaveBeenCalledWith('hipaa');
  });

  it('says, with no framework picked, that names go in as the source holds them and where to pick one', () => {
    // None is the default, as the store and the command line keep it: only
    // the emails and phone numbers are neutralized, and the picker that would
    // mask the names sits folded away.
    const { rerender } = render(<Step4Review {...defaultProps} complianceFramework="none" />);
    expect(screen.getByTestId('step4-no-framework').textContent).toBe(
      'No compliance framework is picked: names, addresses and the other personal fields are ' +
        'copied as the source holds them. Pick one under "Advanced: compliance framework" to ' +
        'anonymize those it covers.',
    );

    rerender(<Step4Review {...defaultProps} complianceFramework="gdpr" />);
    expect(screen.queryByTestId('step4-no-framework')).toBeNull();
  });

  it('says before Execute that SandForge cannot take back what the run writes', () => {
    // Only the FAQ said it: a run keeps no list of what it writes.
    render(<Step4Review {...defaultProps} />);

    const note = screen.getByTestId('step4-no-way-back');
    expect(note.textContent).toBe(
      'SandForge cannot remove what this run writes: try it on a scratch org or a sandbox you can refresh.',
    );
    expect(screen.getByTestId('execute-button').getAttribute('aria-describedby')).toBe(note.id);
  });

  it('holds Execute while the plan is built again', () => {
    render(<Step4Review {...defaultProps} planning />);
    expect(screen.getByTestId('step4-planning')).toBeDefined();
    expect((screen.getByTestId('execute-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('should render without crashing', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('step4-review')).toBeDefined();
  });

  it('should display stat cards', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('stat-objects')).toBeDefined();
    expect(screen.getByTestId('stat-records')).toBeDefined();
    expect(screen.getByTestId('stat-duration')).toBeDefined();
    expect(screen.getByTestId('stat-api-calls')).toBeDefined();
    expect(screen.getByTestId('stat-personal-data')).toBeDefined();
  });

  it('should show object count', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('stat-objects').textContent).toContain('3');
  });

  it('names both orgs by their alias, type and instance, never by the id the store keys them on', () => {
    // The last panel before the write said "Source: org-1 → Target: org-2",
    // a UUID in a real install, on the one screen where the target is checked.
    render(<Step4Review {...defaultProps} />);

    const orgs = screen.getByTestId('step4-orgs');
    expect(orgs.textContent).not.toContain('org-1');
    expect(orgs.textContent).not.toContain('org-2');
    const source = within(screen.getByTestId('step4-source-org'));
    expect(source.getByTestId('org-badge-alias').textContent).toBe('DevSandbox');
    expect(source.getByTestId('org-badge-type').textContent).toBe('SANDBOX');
    expect(source.getByTestId('org-badge-url').textContent).toBe('dev.example.my.salesforce.com');
    const target = within(screen.getByTestId('step4-target-org'));
    expect(target.getByTestId('org-badge-alias').textContent).toBe('QASandbox');
    // A sandbox marked Staging is named so, in the warning colour of its tier.
    expect(target.getByTestId('org-badge-type').textContent).toBe('STAGING');
    expect(target.getByTestId('org-badge-type').className).toContain('bg-status-warning');
    expect(target.getByTestId('org-badge-url').textContent).toBe('qa.example.my.salesforce.com');
  });

  it('names the target it writes into on the button that starts the run', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('execute-button').textContent).toBe('Copy into QASandbox');
  });

  it('says what becomes of the personal data from both choices, in one tile', () => {
    // The tile followed the framework alone: "No anonymization" under the
    // ticked box that neutralizes every email and phone number.
    const tile = (): string | null =>
      screen.getByTestId('stat-personal-data').querySelector('span:last-child')?.textContent ??
      null;
    const { rerender } = render(
      <Step4Review {...defaultProps} complianceFramework="none" neutralizeContactPoints />,
    );
    expect(tile()).toBe('Emails and phones neutralized');

    rerender(<Step4Review {...defaultProps} complianceFramework="gdpr" neutralizeContactPoints />);
    expect(tile()).toBe('GDPR + emails and phones');

    rerender(
      <Step4Review {...defaultProps} complianceFramework="gdpr" neutralizeContactPoints={false} />,
    );
    expect(tile()).toBe('GDPR');

    rerender(
      <Step4Review {...defaultProps} complianceFramework="none" neutralizeContactPoints={false} />,
    );
    expect(tile()).toBe('None: copied as in the source');
    expect(screen.queryByTestId('stat-compliance')).toBeNull();
    expect(screen.queryByTestId('stat-anonymization')).toBeNull();
  });

  it('writes the estimated duration in the language the panel is set to', async () => {
    // "~5 min" was written in the code, the same in all six.
    i18n.addResourceBundle('ja', 'translation', ja, true, true);
    await i18n.changeLanguage('ja');
    try {
      render(<Step4Review {...defaultProps} />);
      expect(screen.getByTestId('stat-duration').textContent).toContain('約 5 分');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('should show selected objects as badges', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
    expect(screen.getByText('Opportunity')).toBeDefined();
  });

  it('should display plan stat cards', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('stat-waves').textContent).toContain('2');
    expect(screen.getByTestId('stat-pii-fields').textContent).toContain('4');
    expect(screen.getByTestId('stat-anonymized-fields').textContent).toContain('3');
  });

  it('should show an error banner when an execution error is present', () => {
    render(<Step4Review {...defaultProps} error="Operation cancelled by user" />);
    expect(screen.getByTestId('autopilot-execute-error')).toBeDefined();
  });

  it('should show execute button', () => {
    render(<Step4Review {...defaultProps} />);
    expect(screen.getByTestId('execute-button')).toBeDefined();
  });

  it('should call onExecute when execute button clicked', () => {
    const onExecute = vi.fn();
    render(<Step4Review {...defaultProps} onExecute={onExecute} />);
    fireEvent.click(screen.getByTestId('execute-button'));
    expect(onExecute).toHaveBeenCalled();
  });

  it('should disable execute button when executing', () => {
    render(<Step4Review {...defaultProps} isExecuting />);
    expect(screen.getByTestId('execute-button')).toHaveProperty('disabled', true);
  });

  it('says what the plan copies of each object, and every lookup it leaves empty with why', () => {
    // A plan for two objects held six hundred, and nothing on the page said
    // which tables it would copy whole.
    render(
      <Step4Review
        {...defaultProps}
        scope={{
          maxDepth: 5,
          maxObjects: 50,
          selected: ['Lead', 'Visit__c'],
          parents: [{ objectApiName: 'PostalCode__c', records: 4 }],
          leftEmpty: [
            {
              objectApiName: 'Visit__c',
              fieldApiName: 'Case__c',
              target: 'Case',
              reason: 'standard',
            },
            {
              objectApiName: 'Visit__c',
              fieldApiName: 'Region__c',
              target: 'Region__c',
              reason: 'objects',
              required: true,
            },
          ],
          standardNeeded: [{ objectApiName: 'Account', neededBy: 'Visit__c.Account__c' }],
        }}
      />,
    );

    const scope = screen.getByTestId('step4-scope');
    expect(scope.textContent).toContain(
      i18n.t('autopilot.step4.scope.selected', { objects: 'Lead, Visit__c' }),
    );
    expect(screen.getByTestId('step4-scope-parents').textContent).toContain('PostalCode__c: 4');
    const leftEmpty = screen.getByTestId('step4-scope-left-empty').textContent ?? '';
    expect(leftEmpty).toContain(
      `Visit__c.Case__c → Case: ${i18n.t('autopilot.step4.scope.reasonStandard')}`,
    );
    expect(leftEmpty).toContain(i18n.t('autopilot.step4.scope.required'));
    expect(scope.textContent).toContain(
      i18n.t('autopilot.step4.scope.standardNeeded', {
        object: 'Account',
        field: 'Visit__c.Account__c',
      }),
    );
  });

  it('says the currencies the target does not hold active, the one their records go in and the objects whose amounts are converted', () => {
    render(
      <Step4Review
        {...defaultProps}
        scope={{
          maxDepth: 5,
          maxObjects: 50,
          selected: ['Opportunity'],
          parents: [{ objectApiName: 'Account', records: 20 }],
          leftEmpty: [],
          standardNeeded: [],
          currencies: {
            notInTarget: ['GBP'],
            writtenIn: 'USD',
            objects: ['Account', 'Opportunity'],
          },
        }}
      />,
    );

    expect(screen.getByTestId('step4-scope-currencies').textContent).toBe(
      i18n.t('autopilot.step4.scope.currencies', {
        currencies: 'GBP',
        writtenIn: 'USD',
        objects: 'Account, Opportunity',
      }),
    );
  });

  it('says which standard parents the plan followed by default, and through which lookups', () => {
    render(
      <Step4Review
        {...defaultProps}
        scope={{
          maxDepth: 5,
          maxObjects: 50,
          selected: ['Opportunity', 'Contact'],
          parents: [{ objectApiName: 'Account', records: 20 }],
          leftEmpty: [],
          standardNeeded: [],
          followedByDefault: [
            {
              objectApiName: 'Account',
              referencedBy: ['Opportunity.AccountId', 'Contact.AccountId'],
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('step4-scope-followed-by-default').textContent).toBe(
      i18n.t('autopilot.step4.scope.followedByDefault', {
        object: 'Account',
        fields: 'Opportunity.AccountId, Contact.AccountId',
      }),
    );
  });

  it('says a selected table is copied from its first records by Id, of how many, and not among those copied whole', () => {
    // Said in the log alone, the plan showed 50 000 beside a count of millions.
    render(
      <Step4Review
        {...defaultProps}
        scope={{
          maxDepth: 5,
          maxObjects: 50,
          selected: ['Account', 'Lead', 'Case'],
          parents: [],
          leftEmpty: [],
          standardNeeded: [],
          cutShort: [
            { objectApiName: 'Account', copied: 50_000, total: 2_000_000 },
            { objectApiName: 'Case', copied: 50_000 },
          ],
        }}
      />,
    );

    const fmt = (n: number): string => n.toLocaleString(uiLocale());
    const lines = screen.getAllByTestId('step4-scope-cut-short').map((line) => line.textContent);
    expect(lines).toEqual([
      i18n.t('autopilot.step4.scope.cutShort', {
        object: 'Account',
        copied: fmt(50_000),
        total: fmt(2_000_000),
      }),
      i18n.t('autopilot.step4.scope.cutShortUncounted', { object: 'Case', copied: fmt(50_000) }),
    ]);
    expect(screen.getByTestId('step4-scope').textContent).toContain(
      i18n.t('autopilot.step4.scope.selected', { objects: 'Lead' }),
    );
  });

  it('warns of a person object whose names, emails or phones no rule anonymizes', () => {
    render(
      <Step4Review
        {...defaultProps}
        notCovered={[{ objectApiName: 'Lead', missing: ['email'] }]}
      />,
    );

    expect(screen.getByTestId('step4-not-covered').textContent).toBe(
      i18n.t('autopilot.step4.notCovered', {
        object: 'Lead',
        missing: i18n.t('autopilot.step4.personal.email'),
      }),
    );
  });

  it('names a custom framework and no framework in the language the panel is set to', async () => {
    // Both read "Custom" and "None" in all six languages.
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      const tile = (): string => screen.getByTestId('stat-personal-data').textContent ?? '';
      const { rerender } = render(<Step4Review {...defaultProps} complianceFramework="custom" />);
      expect(tile()).toContain('Personnalisé + e-mails et téléphones');
      rerender(
        <Step4Review
          {...defaultProps}
          complianceFramework="none"
          neutralizeContactPoints={false}
        />,
      );
      expect(tile()).toContain('Aucune : copiées telles que dans la source');
      expect(tile()).not.toMatch(/None|Custom/);
      rerender(
        <Step4Review
          {...defaultProps}
          complianceFramework="pci_dss"
          neutralizeContactPoints={false}
        />,
      );
      expect(tile()).toContain('PCI-DSS');
      expect(screen.getByTestId('execute-button').textContent).toBe('Copier dans QASandbox');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('shows neither note for a plan that says nothing of them', () => {
    render(<Step4Review {...defaultProps} />);

    expect(screen.queryByTestId('step4-scope')).toBeNull();
    expect(screen.queryByTestId('step4-not-covered')).toBeNull();
  });
});
