import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { ApiUsagePanel } from './ApiUsagePanel';

let mockApiUsageData: Record<string, unknown> | null = null;
let mockApiUsageLoading = false;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:api-usage') {
      return {
        data: mockApiUsageData,
        loading: mockApiUsageLoading,
        error: null,
        refetch: vi.fn(),
      };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

describe('ApiUsagePanel', () => {
  beforeEach(() => {
    mockApiUsageData = null;
    mockApiUsageLoading = false;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('renders loading skeleton when loading', () => {
    mockApiUsageLoading = true;
    render(<ApiUsagePanel />);
    expect(screen.getByTestId('api-usage-panel-loading')).toBeDefined();
  });

  it('renders empty state when no data', () => {
    mockApiUsageData = { success: true, categories: [] };
    render(<ApiUsagePanel />);
    expect(screen.getByTestId('api-usage-panel-empty')).toBeDefined();
    expect(screen.getByText('API Usage Breakdown')).toBeDefined();
  });

  it('renders table with usage bars from mock data', () => {
    mockApiUsageData = {
      success: true,
      categories: [
        { category: 'DailyApiRequests', used: 12000, max: 15000, usedPercent: 80 },
        { category: 'DailyBulkApiRequests', used: 100, max: 10000, usedPercent: 1 },
        { category: 'DailyAsyncApexExecutions', used: 4500, max: 50000, usedPercent: 9 },
      ],
    };
    render(<ApiUsagePanel />);

    expect(screen.getByTestId('api-usage-panel')).toBeDefined();
    expect(screen.getByTestId('api-usage-table')).toBeDefined();
    expect(screen.getByTestId('api-usage-row-DailyApiRequests')).toBeDefined();
    expect(screen.getByTestId('api-usage-row-DailyBulkApiRequests')).toBeDefined();
    expect(screen.getByText('Api Requests')).toBeDefined();
  });

  it('shows warning badge for categories at 80% or above', () => {
    mockApiUsageData = {
      success: true,
      categories: [{ category: 'DailyApiRequests', used: 12000, max: 15000, usedPercent: 85 }],
    };
    render(<ApiUsagePanel />);

    expect(screen.getByTestId('api-usage-badge-warning-DailyApiRequests')).toBeDefined();
    expect(screen.getByText('85%')).toBeDefined();
  });

  it('shows critical badge for categories at 95% or above', () => {
    mockApiUsageData = {
      success: true,
      categories: [{ category: 'DailyBulkApiRequests', used: 9600, max: 10000, usedPercent: 96 }],
    };
    render(<ApiUsagePanel />);

    expect(screen.getByTestId('api-usage-badge-critical-DailyBulkApiRequests')).toBeDefined();
    expect(screen.getByText('96%')).toBeDefined();
  });
});
