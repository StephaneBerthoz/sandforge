import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../../stores/useOrgStore';
import { QuickSyncOrgStep } from './QuickSyncOrgStep';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'prod',
    username: 'user@prod.com',
    instanceUrl: 'https://prod.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Production',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.CRITICAL,
    appearance: { color: '#c23934', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-2',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
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

describe('QuickSyncOrgStep', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: mockOrgs });
  });

  it('renders two select dropdowns', () => {
    render(
      <QuickSyncOrgStep
        sourceOrgId=""
        targetOrgId=""
        onSourceChange={vi.fn()}
        onTargetChange={vi.fn()}
        onNext={vi.fn()}
        canGoNext={false}
      />,
    );

    expect(screen.getByTestId('quick-sync-source-select')).toBeDefined();
    expect(screen.getByTestId('quick-sync-target-select')).toBeDefined();
  });

  it('next button disabled when orgs not selected', () => {
    render(
      <QuickSyncOrgStep
        sourceOrgId=""
        targetOrgId=""
        onSourceChange={vi.fn()}
        onTargetChange={vi.fn()}
        onNext={vi.fn()}
        canGoNext={false}
      />,
    );

    const btn = screen.getByTestId('quick-sync-org-next');
    expect(btn).toBeDefined();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('next button enabled and calls onNext when orgs are valid', () => {
    const onNext = vi.fn();
    render(
      <QuickSyncOrgStep
        sourceOrgId="org-1"
        targetOrgId="org-2"
        onSourceChange={vi.fn()}
        onTargetChange={vi.fn()}
        onNext={onNext}
        canGoNext={true}
      />,
    );

    const btn = screen.getByTestId('quick-sync-org-next');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('shows org badges when orgs are selected', () => {
    render(
      <QuickSyncOrgStep
        sourceOrgId="org-1"
        targetOrgId="org-2"
        onSourceChange={vi.fn()}
        onTargetChange={vi.fn()}
        onNext={vi.fn()}
        canGoNext={true}
      />,
    );

    expect(screen.getByTestId('quick-sync-org-badges')).toBeDefined();
  });
});
