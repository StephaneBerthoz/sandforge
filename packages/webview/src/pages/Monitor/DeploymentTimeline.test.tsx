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
      return {
        data: mockDeploymentData,
        loading: mockDeploymentLoading,
        error: null,
        refetch: vi.fn(),
      };
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

  const deployment = {
    id: 'dep-4',
    status: 'Succeeded',
    startDate: '2026-03-16T14:00:00Z',
    createdBy: 'Admin User',
    componentCount: 5,
    errorCount: 0,
  };

  it('lists a deployment whose start is not a date, and says it is unknown', () => {
    // Formatting it threw "Invalid time value", and no deployment showed.
    mockDeploymentData = {
      success: true,
      deployments: [{ ...deployment, startDate: 'not a date' }],
    };
    render(<DeploymentTimeline />);

    const list = screen.getByTestId('deployment-timeline-list');
    expect(list.textContent).toContain('Admin User');
    expect(list.textContent).toContain('unknown');
  });

  it('says the timeline stops where the read did when older deployments were left unread', () => {
    // Run against a real sandbox, the read came back full at twenty and the
    // page showed a badge of 20 as though that were every deployment.
    mockDeploymentData = { success: true, deployments: [deployment], truncated: true };
    render(<DeploymentTimeline />);

    expect(screen.getByTestId('deployment-list-cap').textContent).toBe(
      'Only the 1 most recent are read here: the list and its counts stop there.',
    );
  });

  it('says nothing of a bound when the timeline is complete', () => {
    mockDeploymentData = { success: true, deployments: [deployment], truncated: false };
    render(<DeploymentTimeline />);

    expect(screen.queryByTestId('deployment-list-cap')).toBeNull();
  });
});
