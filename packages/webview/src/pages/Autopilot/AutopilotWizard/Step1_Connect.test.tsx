import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { Step1Connect } from './Step1_Connect';
import type { SalesforceOrg } from '@sandforge/shared';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'dev@test.com',
    instanceUrl: 'https://dev.salesforce.com',
    status: 'connected',
    orgType: 'sandbox',
    safetyTier: 'safe',
    accessToken: '',
    refreshToken: '',
    apiVersion: '59.0',
    connectedAt: '2026-01-01T00:00:00Z',
    lastUsedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'org-2',
    alias: 'QASandbox',
    username: 'qa@test.com',
    instanceUrl: 'https://qa.salesforce.com',
    status: 'connected',
    orgType: 'sandbox',
    safetyTier: 'caution',
    accessToken: '',
    refreshToken: '',
    apiVersion: '59.0',
    connectedAt: '2026-01-01T00:00:00Z',
    lastUsedAt: '2026-01-01T00:00:00Z',
  },
];

describe('Step1_Connect', () => {
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
