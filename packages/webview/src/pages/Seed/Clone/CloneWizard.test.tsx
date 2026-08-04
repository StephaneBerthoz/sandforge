import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../../stores/useOrgStore';
import { CloneWizard } from './CloneWizard';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const mockDescribeMutate = vi.fn();
const mockDescribeReset = vi.fn();
const mockPreviewMutate = vi.fn();
const mockPreviewReset = vi.fn();
const mockExecuteMutate = vi.fn();
const mockExecuteReset = vi.fn();

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'seed:clone:describe-source') {
      return {
        mutate: mockDescribeMutate,
        data: null,
        loading: false,
        error: null,
        reset: mockDescribeReset,
      };
    }
    if (type === 'seed:clone:preview') {
      return {
        mutate: mockPreviewMutate,
        data: null,
        loading: false,
        error: null,
        reset: mockPreviewReset,
      };
    }
    if (type === 'seed:clone:execute') {
      return {
        mutate: mockExecuteMutate,
        data: null,
        loading: false,
        error: null,
        reset: mockExecuteReset,
      };
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

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
    alias: 'dev2',
    username: 'user@dev2.com',
    instanceUrl: 'https://dev2.salesforce.com',
    orgId: '00D000000000002',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 1 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

describe('CloneWizard', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    mockDescribeMutate.mockClear();
    mockDescribeReset.mockClear();
    mockPreviewMutate.mockClear();
    mockPreviewReset.mockClear();
    mockExecuteMutate.mockClear();
    mockExecuteReset.mockClear();
  });

  it('should render the clone wizard container', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-wizard-container')).toBeDefined();
    expect(screen.getByTestId('clone-wizard')).toBeDefined();
  });

  it('should render 4-step wizard with step indicators', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-step-indicator')).toBeDefined();
    expect(screen.getByTestId('clone-step-indicator').children.length).toBe(4);
  });

  it('should start on step 1 -- source org picker', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-source-picker')).toBeDefined();
  });

  it('should show source org select excluding target org', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    const select = screen.getByTestId('clone-source-select') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    const optionValues = options.map((o) => o.value).filter((v) => v !== '');

    // org-1 is the selected/target org, should be excluded
    expect(optionValues).not.toContain('org-1');
    expect(optionValues).toContain('org-2');
  });

  it('should disable next button when no source org is selected', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    const nextBtn = screen.getByTestId('clone-wizard-next');
    expect(nextBtn).toHaveProperty('disabled', true);
  });

  it('should render wizard with correct test ID prefix', () => {
    render(<CloneWizard onBack={vi.fn()} />);

    expect(screen.getByTestId('clone-wizard-back')).toBeDefined();
    expect(screen.getByTestId('clone-wizard-next')).toBeDefined();
  });
});
