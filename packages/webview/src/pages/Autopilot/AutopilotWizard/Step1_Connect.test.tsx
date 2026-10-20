import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { useOrgStore } from '../../../stores/useOrgStore';
import { useAppStore } from '../../../stores/useAppStore';
import { Step1Connect } from './Step1_Connect';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'dev@test.com',
    instanceUrl: 'https://dev.salesforce.com',
    orgId: '00D000000000001',
    status: 'connected',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    lastConnected: '2026-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-2',
    alias: 'QASandbox',
    username: 'qa@test.com',
    instanceUrl: 'https://qa.salesforce.com',
    orgId: '00D000000000002',
    status: 'connected',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#0070d2', icon: 'cloud', position: 1 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    lastConnected: '2026-01-01T00:00:00Z',
    tags: [],
  },
];

describe('Step1_Connect', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useAppStore.setState({ currentRoute: 'autopilot', navigationIntent: null });
  });

  it('points at Seed with one org, which the second list can only offer disabled', () => {
    useOrgStore.setState({ orgs: [mockOrgs[0]], selectedOrgId: 'org-1' });
    render(
      <Step1Connect
        orgs={[mockOrgs[0]]}
        sourceOrgId="org-1"
        targetOrgId=""
        onSourceSelect={vi.fn()}
        onTargetSelect={vi.fn()}
      />,
    );

    const link = screen.getByTestId('autopilot-seed-instead-action');
    expect(link.textContent).toBe('Only one org? Generate realistic data with Seed');
    fireEvent.click(link);
    expect(useAppStore.getState().navigationIntent).toMatchObject({
      route: 'seed',
      seedMode: 'quick-seed',
      targetOrgId: 'org-1',
    });
  });

  it('says nothing of Seed once two orgs are connected', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(
      <Step1Connect
        orgs={mockOrgs}
        sourceOrgId=""
        targetOrgId=""
        onSourceSelect={vi.fn()}
        onTargetSelect={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('autopilot-seed-instead')).toBeNull();
  });

  it('should render without crashing', () => {
    render(
      <Step1Connect
        orgs={mockOrgs}
        sourceOrgId=""
        targetOrgId=""
        onSourceSelect={vi.fn()}
        onTargetSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('step1-connect')).toBeDefined();
  });

  it('should show source and target org selectors', () => {
    render(
      <Step1Connect
        orgs={mockOrgs}
        sourceOrgId=""
        targetOrgId=""
        onSourceSelect={vi.fn()}
        onTargetSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('source-selector')).toBeDefined();
    expect(screen.getByTestId('target-selector')).toBeDefined();
  });

  it('should call onSourceSelect when org is clicked', () => {
    const onSourceSelect = vi.fn();
    render(
      <Step1Connect
        orgs={mockOrgs}
        sourceOrgId=""
        targetOrgId=""
        onSourceSelect={onSourceSelect}
        onTargetSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('source-org-org-1'));
    expect(onSourceSelect).toHaveBeenCalledWith('org-1');
  });

  it('should call onTargetSelect when org is clicked', () => {
    const onTargetSelect = vi.fn();
    render(
      <Step1Connect
        orgs={mockOrgs}
        sourceOrgId=""
        targetOrgId=""
        onSourceSelect={vi.fn()}
        onTargetSelect={onTargetSelect}
      />,
    );
    fireEvent.click(screen.getByTestId('target-org-org-2'));
    expect(onTargetSelect).toHaveBeenCalledWith('org-2');
  });

  it('should show empty state when no orgs', () => {
    render(
      <Step1Connect
        orgs={[]}
        sourceOrgId=""
        targetOrgId=""
        onSourceSelect={vi.fn()}
        onTargetSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByText('No orgs available — connect one first.')).toHaveLength(2);
  });
});
