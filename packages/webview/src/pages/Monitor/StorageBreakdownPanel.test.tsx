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
    expect(screen.getByText('Records by Object')).toBeDefined();
    expect(screen.getByText('No record counts available')).toBeDefined();
  });

  /** The top of a real sandbox's record counts: setup and log objects first. */
  const SETUP_LED = [
    { objectName: 'ObjectPermissions', label: 'Object Permissions', recordCount: 37000 },
    { objectName: 'FieldPermissions', label: 'Field Permissions', recordCount: 36900 },
    { objectName: 'LoginHistory', label: 'Login History', recordCount: 7200 },
  ];

  it('calls the list what it is, not a storage breakdown', () => {
    // ObjectPermissions and LoginHistory led a list titled "Storage Breakdown",
    // on an org whose records used 6 MB of data storage in all.
    mockStorageData = { success: true, totalRecords: 81100, objects: SETUP_LED, objectCount: 3 };
    render(<StorageBreakdownPanel />);

    expect(screen.getByRole('heading', { name: 'Records by Object' })).toBeDefined();
    expect(screen.queryByText('Storage Breakdown')).toBeNull();
    expect(screen.getByTestId('storage-scope').textContent).toBe(
      'Every object the org counts, setup and log objects included: not what uses data storage, which the Data Storage tile shows.',
    );
  });

  it('says how many objects the org counted when it lists only the first of them', () => {
    mockStorageData = { success: true, totalRecords: 133989, objects: SETUP_LED, objectCount: 216 };
    render(<StorageBreakdownPanel />);

    expect(screen.getByTestId('storage-scope').textContent).toContain(
      'The 3 objects holding the most records, of 216.',
    );
  });

  it('says nothing of a remainder when every counted object is listed', () => {
    mockStorageData = { success: true, totalRecords: 81100, objects: SETUP_LED, objectCount: 3 };
    render(<StorageBreakdownPanel />);

    expect(screen.getByTestId('storage-scope').textContent).not.toContain('holding the most');
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
