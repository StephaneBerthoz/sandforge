import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { SeedSelectStep } from './SeedSelectStep';
import type { SeedSelectStepProps } from './SeedSelectStep';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';

/** The NL2SOQL answer under test, wrapped in the mutation shape the step reads. */
function nl2soqlStub(
  data: {
    success: boolean;
    soql?: string;
    explanation?: string;
    error?: string;
    verified?: boolean;
    unverifiedReason?: 'fields-unknown' | 'nothing-to-check';
  } | null,
): SeedSelectStepProps['nl2soql'] {
  return {
    mutate: vi.fn(),
    data,
    loading: false,
    error: null,
    reset: vi.fn(),
  } as unknown as SeedSelectStepProps['nl2soql'];
}

function renderStep(nl2soql: SeedSelectStepProps['nl2soql']) {
  render(
    <SeedSelectStep
      availableObjects={[]}
      loadingObjects={false}
      volumes={{}}
      onChangeVolume={vi.fn()}
      hasPiiWarnings={false}
      piiResults={[]}
      nl2soqlQuery="everything from last week"
      onNl2soqlQueryChange={vi.fn()}
      onNl2soqlSubmit={vi.fn()}
      nl2soql={nl2soql}
    />,
  );
}

describe('SeedSelectStep record counts', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: 'org-1' });
    useSeedWizardStore.setState({ selectedOrgId: 'org-1', selectedObjects: ['Account'] });
  });

  it('names each record-count field after its object', () => {
    // One field per selected object under a single "Record count" heading:
    // the heading names the list, not the twelfth field in it.
    renderStep(nl2soqlStub(null));
    expect(screen.getByTestId('volume-Account').getAttribute('aria-label')).toContain('Account');
  });
});

describe('SeedSelectStep PII warning', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: 'org-1' });
    useSeedWizardStore.setState({ selectedOrgId: 'org-1', selectedObjects: ['Contact'] });
  });

  it('sets a field’s PII type apart from its confidence with a dash, not two hyphens', () => {
    render(
      <SeedSelectStep
        availableObjects={[]}
        loadingObjects={false}
        volumes={{}}
        onChangeVolume={vi.fn()}
        hasPiiWarnings
        piiResults={[
          {
            objectName: 'Contact',
            piiFields: [{ fieldName: 'Email', piiType: 'email', confidence: 0.92 }],
          },
        ]}
        nl2soqlQuery=""
        onNl2soqlQueryChange={vi.fn()}
        onNl2soqlSubmit={vi.fn()}
        nl2soql={nl2soqlStub(null)}
      />,
    );

    expect(screen.getByTestId('pii-scan-warning').textContent).toContain('Email (email — 92%)');
  });
});

describe('SeedSelectStep org picker', () => {
  /** An org of `orgType` as the store holds it. */
  function org(id: string, alias: string, orgType: SalesforceOrg['orgType']): SalesforceOrg {
    return {
      id,
      alias,
      username: `${alias}@example.test`,
      instanceUrl: 'https://example.my.salesforce.com',
      orgId: id,
      orgType,
      authMethod: 'sfdx_import',
      safetyTier: OrgSafetyTier.LOW,
      appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
      metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
      status: 'connected',
      lastConnected: '2026-09-01T08:00:00.000Z',
      tags: [],
    };
  }

  beforeEach(() => {
    useOrgStore.setState({
      orgs: [org('org-1', 'uat', 'Sandbox'), org('org-2', 'feature', 'Scratch')],
      selectedOrgId: 'org-1',
    });
    useSeedWizardStore.setState({ selectedOrgId: '', selectedObjects: [] });
  });

  it('offers each org under the type the org badges give it, a scratch org as one', () => {
    // Every org but a production one used to be offered as [SBX].
    renderStep(nl2soqlStub(null));

    expect(screen.getByRole('option', { name: 'uat [SANDBOX]' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'feature [SCRATCH]' })).toBeDefined();
    expect(screen.queryByText(/\[SBX\]/)).toBeNull();
  });
});

describe('SeedSelectStep NL2SOQL draft', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: 'org-1' });
    useSeedWizardStore.setState({ selectedOrgId: 'org-1', selectedObjects: [] });
  });

  it('warns, in the panel, that a draft could not be checked against the org', () => {
    renderStep(nl2soqlStub({ success: true, soql: 'SELECT Id FROM Contact', verified: false }));

    const notice = screen.getByTestId('nl2soql-unverified');
    expect(notice.textContent).toMatch(/could not check/i);
    // No jargon: the word the extension uses internally never reaches the user.
    expect(notice.textContent).not.toMatch(/describe/i);
  });

  it('tells the two causes apart instead of blaming the org for both', () => {
    renderStep(
      nl2soqlStub({
        success: true,
        soql: 'SELECT Account.Name FROM Contact',
        verified: false,
        unverifiedReason: 'nothing-to-check',
      }),
    );

    const notice = screen.getByTestId('nl2soql-unverified');
    // The org answered here; what it answered had nothing to compare the draft
    // against, so the line must not read as a failed lookup.
    expect(notice.textContent).not.toMatch(/could not check this draft's field names/i);
    expect(notice.textContent).toMatch(/related records/i);
    // No jargon: the words the extension uses internally never reach the user.
    expect(notice.textContent).not.toMatch(/describe|relationship|aggregate|SELECT/i);
  });

  it('says nothing extra when the draft was checked against the org', () => {
    renderStep(nl2soqlStub({ success: true, soql: 'SELECT Id FROM Account', verified: true }));

    expect(screen.queryByTestId('nl2soql-unverified')).toBeNull();
  });

  it('says nothing extra when the producer stated no verdict', () => {
    renderStep(nl2soqlStub({ success: true, soql: 'SELECT Id FROM Account' }));

    expect(screen.queryByTestId('nl2soql-unverified')).toBeNull();
  });

  it('leaves a rejected draft to the error line alone', () => {
    renderStep(
      nl2soqlStub({
        success: false,
        soql: 'SELECT Bogus__c FROM Account',
        error: 'Field "Bogus__c" not found on object "Account"',
        verified: true,
      }),
    );

    expect(screen.queryByTestId('nl2soql-unverified')).toBeNull();
    expect(screen.getByTestId('nl2soql-error').textContent).toContain('Bogus__c');
  });
});
