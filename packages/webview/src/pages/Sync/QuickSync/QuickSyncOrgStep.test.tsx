import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { useOrgStore } from '../../../stores/useOrgStore';
import { QuickSyncOrgStep } from './QuickSyncOrgStep';

const mockOrgs = [
  { id: 'org-1', alias: 'prod', username: 'user@prod.com', instanceUrl: 'https://prod.salesforce.com', orgType: 'production' as const, status: 'connected' as const, safetyTier: 'critical' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
  { id: 'org-2', alias: 'dev1', username: 'user@dev1.com', instanceUrl: 'https://dev1.salesforce.com', orgType: 'sandbox' as const, status: 'connected' as const, safetyTier: 'low' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
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
