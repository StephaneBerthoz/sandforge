import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { ErrorLogsPanel } from './ErrorLogsPanel';

let mockData: Record<string, unknown> | null = null;
let mockLoading = false;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:error-logs') {
      return { data: mockData, loading: mockLoading, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

describe('ErrorLogsPanel', () => {
  beforeEach(() => {
    mockData = null;
    mockLoading = false;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('renders loading skeleton when loading', () => {
    mockLoading = true;
    render(<ErrorLogsPanel />);
    expect(screen.getByTestId('error-logs-panel-loading')).toBeDefined();
  });

  it('renders empty state when no errors', () => {
    mockData = { success: true, errors: [], errorsByType: [], totalCount: 0 };
    render(<ErrorLogsPanel />);
    expect(screen.getByTestId('error-logs-panel-empty')).toBeDefined();
    expect(screen.getByText('Error Logs')).toBeDefined();
  });

  it('renders error list with type badges', () => {
    mockData = {
      success: true,
      errors: [
        {
          id: 'err-1',
          errorType: 'APEX_ERROR',
          message: 'Null pointer exception',
          timestamp: '2026-03-20T10:00:00Z',
          user: 'admin',
        },
        {
          id: 'err-2',
          errorType: 'VALIDATION',
          message: 'Required field missing',
          timestamp: '2026-03-20T10:05:00Z',
        },
      ],
      errorsByType: [
        { type: 'APEX_ERROR', count: 1 },
        { type: 'VALIDATION', count: 1 },
      ],
      totalCount: 2,
    };
    render(<ErrorLogsPanel />);

    expect(screen.getByTestId('error-logs-panel')).toBeDefined();
    expect(screen.getByTestId('error-log-row-err-1')).toBeDefined();
    expect(screen.getByTestId('error-log-row-err-2')).toBeDefined();
    expect(screen.getByText('APEX_ERROR')).toBeDefined();
    expect(screen.getByText('VALIDATION')).toBeDefined();
  });

  it('shows total count badge', () => {
    mockData = {
      success: true,
      errors: [
        {
          id: 'err-1',
          errorType: 'APEX_ERROR',
          message: 'Error 1',
          timestamp: '2026-03-20T10:00:00Z',
        },
        {
          id: 'err-2',
          errorType: 'APEX_ERROR',
          message: 'Error 2',
          timestamp: '2026-03-20T10:01:00Z',
        },
        {
          id: 'err-3',
          errorType: 'VALIDATION',
          message: 'Error 3',
          timestamp: '2026-03-20T10:02:00Z',
        },
      ],
      errorsByType: [
        { type: 'APEX_ERROR', count: 2 },
        { type: 'VALIDATION', count: 1 },
      ],
      totalCount: 3,
    };
    render(<ErrorLogsPanel />);

    expect(screen.getByTestId('error-logs-panel')).toBeDefined();
    // The total count badge shows "3"
    const badges = screen.getAllByText('3');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('says the list and its counts stop where the read did', () => {
    // The read stopped at 50 errors without a word: the total badge and the
    // per-type counts said 50 about a day that held more.
    mockData = {
      success: true,
      errors: [
        {
          id: 'err-1',
          errorType: 'Failed',
          message: 'Api - Failed',
          timestamp: '2026-03-20T10:00:00Z',
        },
        {
          id: 'err-2',
          errorType: 'Failed',
          message: 'Api - Failed',
          timestamp: '2026-03-20T09:00:00Z',
        },
      ],
      errorsByType: [{ type: 'Failed', count: 2 }],
      totalCount: 2,
      truncated: true,
    };
    render(<ErrorLogsPanel />);

    expect(screen.getByTestId('error-logs-list-cap').textContent).toBe(
      'Only the 2 most recent are read here: the list and its counts stop there.',
    );
  });

  it('says nothing of a bound when the list is complete', () => {
    mockData = {
      success: true,
      errors: [
        {
          id: 'err-1',
          errorType: 'Failed',
          message: 'Api - Failed',
          timestamp: '2026-03-20T10:00:00Z',
        },
      ],
      errorsByType: [{ type: 'Failed', count: 1 }],
      totalCount: 1,
      truncated: false,
    };
    render(<ErrorLogsPanel />);

    expect(screen.queryByTestId('error-logs-list-cap')).toBeNull();
  });
});
