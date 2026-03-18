import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { StorageBreakdownPanel } from './StorageBreakdownPanel';

/* Mock recharts ResponsiveContainer */
vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container" style={{ width: 400, height: 200 }}>
        {children}
      </div>
    ),
  };
});

let mockStorageData: Record<string, unknown> | null = null;
let mockStorageLoading = false;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:storage') {
      return { data: mockStorageData, loading: mockStorageLoading, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

describe('StorageBreakdownPanel', () => {
  beforeEach(() => {
    mockStorageData = null;
    mockStorageLoading = false;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('renders loading skeleton when loading', () => {
    mockStorageLoading = true;
    render(<StorageBreakdownPanel />);
    expect(screen.getByTestId('storage-panel-loading')).toBeDefined();
  });

  it('renders empty state when no data', () => {
    mockStorageData = { success: true, objects: [], totalRecords: 0 };
    render(<StorageBreakdownPanel />);
    expect(screen.getByTestId('storage-panel-empty')).toBeDefined();
    expect(screen.getByText('Storage Breakdown')).toBeDefined();
  });

  it('renders donut chart and table with mock data', () => {
    mockStorageData = {
      success: true,
      totalRecords: 15000,
      objects: [
        { objectName: 'Account', label: 'Account', recordCount: 5000 },
        { objectName: 'Contact', label: 'Contact', recordCount: 4000 },
        { objectName: 'Lead', label: 'Lead', recordCount: 3000 },
        { objectName: 'Opportunity', label: 'Opportunity', recordCount: 2000 },
        { objectName: 'Case', label: 'Case', recordCount: 1000 },
      ],
    };
    render(<StorageBreakdownPanel />);

    expect(screen.getByTestId('storage-panel')).toBeDefined();
    expect(screen.getByTestId('storage-donut-chart')).toBeDefined();
    expect(screen.getByTestId('storage-table')).toBeDefined();
    expect(screen.getByTestId('storage-row-Account')).toBeDefined();
    expect(screen.getByTestId('storage-row-Contact')).toBeDefined();
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
  });

  it('shows percentage for each object', () => {
    mockStorageData = {
      success: true,
      totalRecords: 10000,
      objects: [
        { objectName: 'Account', label: 'Account', recordCount: 7000 },
        { objectName: 'Contact', label: 'Contact', recordCount: 3000 },
      ],
    };
    render(<StorageBreakdownPanel />);

    expect(screen.getByText('70%')).toBeDefined();
    expect(screen.getByText('30%')).toBeDefined();
  });
});
