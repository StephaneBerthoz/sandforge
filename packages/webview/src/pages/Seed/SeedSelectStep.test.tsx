import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { SeedSelectStep } from './SeedSelectStep';
import type { SeedSelectStepProps } from './SeedSelectStep';

/** The NL2SOQL answer under test, wrapped in the mutation shape the step reads. */
function nl2soqlStub(
  data: {
    success: boolean;
    soql?: string;
    explanation?: string;
    error?: string;
    verified?: boolean;
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
