import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { RefreshPanel } from './RefreshPanel';

let mockData: Record<string, unknown> | null = null;
let mockLoading = false;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:sandbox-refresh') {
      return { data: mockData, loading: mockLoading, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

describe('RefreshPanel', () => {
  beforeEach(() => {
    mockData = null;
    mockLoading = false;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('renders loading skeleton when loading', () => {
    mockLoading = true;
    render(<RefreshPanel />);
    expect(screen.getByTestId('refresh-panel-loading')).toBeDefined();
  });

  it('renders empty state when no refreshes', () => {
    mockData = { success: true, refreshes: [], inProgress: false };
    render(<RefreshPanel />);
    expect(screen.getByTestId('refresh-panel-empty')).toBeDefined();
    expect(screen.getByText('Sandbox Refreshes')).toBeDefined();
  });

  it('renders refresh rows with status badges', () => {
    mockData = {
      success: true,
      refreshes: [
        {
          orgId: 'org-1',
          sandboxName: 'DevSandbox',
          refreshDate: '2026-03-20T10:00:00Z',
          status: 'Processing',
        },
        {
          orgId: 'org-2',
          sandboxName: 'QASandbox',
          refreshDate: '2026-03-19T08:00:00Z',
          status: 'Completed',
          sourceOrg: 'Production',
        },
      ],
      inProgress: false,
    };
    render(<RefreshPanel />);

    expect(screen.getByTestId('refresh-panel')).toBeDefined();
    expect(screen.getByTestId('refresh-row-DevSandbox')).toBeDefined();
    expect(screen.getByTestId('refresh-row-QASandbox')).toBeDefined();
    expect(screen.getByText('Processing')).toBeDefined();
    expect(screen.getByText('Completed')).toBeDefined();
  });

  it('shows in-progress indicator when refresh is active', () => {
    mockData = {
      success: true,
      refreshes: [
        {
          orgId: 'org-1',
          sandboxName: 'DevSandbox',
          refreshDate: '2026-03-20T10:00:00Z',
          status: 'Processing',
        },
      ],
      inProgress: true,
    };
    render(<RefreshPanel />);

    expect(screen.getByTestId('refresh-in-progress')).toBeDefined();
    expect(screen.getByText('Refresh in progress')).toBeDefined();
  });
});
