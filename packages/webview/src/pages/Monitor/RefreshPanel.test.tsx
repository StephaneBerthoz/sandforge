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
    mockData = { success: true, supported: true, refreshes: [], inProgress: false };
    render(<RefreshPanel />);
    expect(screen.getByTestId('refresh-panel-empty')).toBeDefined();
    expect(screen.getByText('Sandbox Refreshes')).toBeDefined();
  });

  it('says the org cannot be asked instead of showing the empty state', () => {
    // A sandbox org has no SandboxProcess to query: the same empty list used
    // to read as "this org has had no refresh".
    mockData = { success: true, supported: false, refreshes: [], inProgress: false };
    render(<RefreshPanel />);
    expect(screen.queryByTestId('refresh-panel-empty')).toBeNull();
    expect(screen.getByTestId('refresh-panel-unsupported').textContent).toMatch(
      /manages sandboxes/i,
    );
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

  describe('refreshes SandForge noticed on the org itself', () => {
    /** A refresh as the host sends it: the org answered with another org id. */
    const noticed = {
      detectedAt: '2026-09-22T09:00:00.000Z',
      evidence: 'connection',
      previousOrganizationId: '00DXX00000AbCdE',
      organizationId: '00Dxx00000FgHiJ',
      previousInstanceName: 'EU42S',
      instanceName: 'EU44S',
    };

    it('shows on a sandbox the refresh it revealed, under the note that it keeps no history', () => {
      // A sandbox cannot list its refreshes: this is the only one it can show.
      mockData = {
        success: true,
        supported: false,
        refreshes: [],
        inProgress: false,
        detected: [noticed],
      };
      render(<RefreshPanel />);

      expect(screen.getByTestId('refresh-panel-unsupported')).toBeDefined();
      const row = screen.getByTestId('refresh-detected-row').textContent ?? '';
      expect(row).toContain('Noticed when SandForge connected to it');
      expect(row).toContain('Was org 00DXX00000AbCdE, now org 00Dxx00000FgHiJ');
      expect(row).toContain('Moved from instance EU42S to EU44S');
    });

    it('names the production org whose history reported the refresh', () => {
      useOrgStore.setState({
        selectedOrgId: 'org-1',
        orgs: [{ id: '00Dxx00000KlMnO4C3', alias: 'PROD' } as never],
      });
      mockData = {
        success: true,
        supported: false,
        refreshes: [],
        inProgress: false,
        detected: [
          {
            detectedAt: '2026-09-22T09:00:00.000Z',
            evidence: 'production',
            reportedBy: '00Dxx00000KlMnO4C3',
          },
        ],
      };
      render(<RefreshPanel />);

      const row = screen.getByTestId('refresh-detected-row').textContent ?? '';
      expect(row).toContain('Reported by the refresh history of PROD');
      // The new org id is not known until the sandbox answers.
      expect(row).not.toContain('Was org');
    });

    it('shows them under an empty history as well', () => {
      mockData = {
        success: true,
        supported: true,
        refreshes: [],
        inProgress: false,
        detected: [noticed],
      };
      render(<RefreshPanel />);

      expect(screen.getByTestId('refresh-panel-empty')).toBeDefined();
      expect(screen.getByTestId('refresh-detected')).toBeDefined();
    });

    it('adds nothing when no refresh was noticed', () => {
      mockData = {
        success: true,
        supported: false,
        refreshes: [],
        inProgress: false,
        detected: [],
      };
      render(<RefreshPanel />);

      expect(screen.queryByTestId('refresh-detected')).toBeNull();
    });
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

  const refresh = {
    orgId: 'org-1',
    sandboxName: 'DevSandbox',
    refreshDate: '2026-03-20T10:00:00Z',
    status: 'Completed',
  };

  it('says the list stops where the read did when older refreshes were left unread', () => {
    mockData = {
      success: true,
      supported: true,
      refreshes: [refresh],
      inProgress: false,
      truncated: true,
    };
    render(<RefreshPanel />);

    expect(screen.getByTestId('refresh-list-cap').textContent).toBe(
      'Only the 1 most recent are read here: the list and its counts stop there.',
    );
  });

  it('says nothing of a bound when the list is complete', () => {
    mockData = {
      success: true,
      supported: true,
      refreshes: [refresh],
      inProgress: false,
      truncated: false,
    };
    render(<RefreshPanel />);

    expect(screen.queryByTestId('refresh-list-cap')).toBeNull();
  });
});
