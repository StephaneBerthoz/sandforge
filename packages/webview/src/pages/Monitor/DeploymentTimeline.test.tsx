import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { DeploymentTimeline } from './DeploymentTimeline';

let mockDeploymentData: Record<string, unknown> | null = null;
let mockDeploymentLoading = false;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:deployments') {
      return { data: mockDeploymentData, loading: mockDeploymentLoading, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

describe('DeploymentTimeline', () => {
  beforeEach(() => {
    mockDeploymentData = null;
    mockDeploymentLoading = false;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('renders loading skeleton when loading', () => {
    mockDeploymentLoading = true;
    render(<DeploymentTimeline />);
    expect(screen.getByTestId('deployment-timeline-loading')).toBeDefined();
  });

  it('renders empty state when no deployments', () => {
    mockDeploymentData = { success: true, deployments: [] };
    render(<DeploymentTimeline />);
    expect(screen.getByTestId('deployment-timeline')).toBeDefined();
    expect(screen.getByTestId('deployment-timeline-empty')).toBeDefined();
    expect(screen.getByText('No recent deployments')).toBeDefined();
  });

  it('renders timeline entries from mock data', () => {
    mockDeploymentData = {
      success: true,
      deployments: [
        {
          id: 'dep-1',
          status: 'Succeeded',
          startDate: '2026-03-17T10:00:00Z',
          completedDate: '2026-03-17T10:05:00Z',
          createdBy: 'Admin User',
          componentCount: 42,
          errorCount: 0,
        },
        {
          id: 'dep-2',
          status: 'Failed',
          startDate: '2026-03-16T14:00:00Z',
          createdBy: 'Dev User',
          componentCount: 10,
          errorCount: 3,
        },
      ],
    };
    render(<DeploymentTimeline />);

    expect(screen.getByTestId('deployment-timeline')).toBeDefined();
    expect(screen.getByTestId('deployment-timeline-list')).toBeDefined();
    expect(screen.getByText('Recent Deployments')).toBeDefined();
    // Check deployer names appear in timeline
    expect(screen.getByText(/Admin User/)).toBeDefined();
    expect(screen.getByText(/Dev User/)).toBeDefined();
  });

  it('shows error count for failed deployments', () => {
    mockDeploymentData = {
      success: true,
      deployments: [
        {
          id: 'dep-3',
          status: 'Failed',
          startDate: '2026-03-16T14:00:00Z',
          createdBy: 'QA User',
          componentCount: 5,
          errorCount: 2,
        },
      ],
    };
    render(<DeploymentTimeline />);

    expect(screen.getByText(/2 errors/)).toBeDefined();
  });
});
