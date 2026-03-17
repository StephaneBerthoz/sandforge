import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { StatusFooter } from './StatusFooter';
import { OrgSafetyTier } from '@sandforge/shared';

const mockOrg = (id: string, status: 'connected' | 'expired' = 'connected') => ({
  id,
  alias: `org-${id}`,
  username: `user@${id}.com`,
  instanceUrl: 'https://test.salesforce.com',
  orgId: `00D${id}`,
  orgType: 'Sandbox' as const,
  authMethod: 'oauth_web' as const,
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#10B981', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status,
  lastConnected: '2024-01-01T00:00:00Z',
  tags: [],
});

describe('StatusFooter', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('should render with zero orgs', () => {
    render(<StatusFooter />);
    expect(screen.getByText(/0 orgs/)).toBeDefined();
  });

  it('should show connected org count', () => {
    useOrgStore.setState({ orgs: [mockOrg('1'), mockOrg('2')] });
    render(<StatusFooter />);
    expect(screen.getByText(/2 orgs/)).toBeDefined();
  });

  it('should only count connected orgs', () => {
    useOrgStore.setState({ orgs: [mockOrg('1'), mockOrg('2', 'expired')] });
    render(<StatusFooter />);
    expect(screen.getByText(/1 org(?!s)/)).toBeDefined();
  });

  it('should show API usage when provided', () => {
    render(<StatusFooter apiUsagePercent={45} />);
    expect(screen.getByText('API: 45%')).toBeDefined();
  });

  it('should show active jobs when greater than zero', () => {
    render(<StatusFooter activeJobs={3} />);
    expect(screen.getByText('Jobs: 3')).toBeDefined();
  });

  it('should show version info', () => {
    render(<StatusFooter />);
    expect(screen.getByText('SandForge v3.0.0')).toBeDefined();
  });
});
