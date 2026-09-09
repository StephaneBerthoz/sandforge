import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SyncExecutionResult } from '@sandforge/shared';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { MigrationPage } from './MigrationPage';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockSfdmuMutate = vi.fn();
const mockSfdmuReset = vi.fn();
const mockUniversalMutate = vi.fn();
const mockUniversalReset = vi.fn();

interface MockMutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: {
    success: boolean;
    config?: Record<string, unknown>;
    detectedFormat?: string;
    error?: string;
  } | null;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
}

/** Mutable mutation state for migration:import-sfdmu. */
let mockSfdmuState: MockMutationState = {
  mutate: mockSfdmuMutate,
  data: null,
  loading: false,
  error: null,
  reset: mockSfdmuReset,
};

/** Mutable mutation state for migration:import. */
let mockUniversalState: MockMutationState = {
  mutate: mockUniversalMutate,
  data: null,
  loading: false,
  error: null,
  reset: mockUniversalReset,
};

const mockRunMutate = vi.fn();
const mockRunReset = vi.fn();

/** Mutable mutation state for sync:execute (the "run this import" button). */
let mockRunState: {
  mutate: ReturnType<typeof vi.fn>;
  data: SyncExecutionResult | null;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
} = {
  mutate: mockRunMutate,
  data: null,
  loading: false,
  error: null,
  reset: mockRunReset,
};

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'migration:import-sfdmu') {
      return mockSfdmuState;
    }
    if (type === 'migration:import') {
      return mockUniversalState;
    }
    if (type === 'sync:execute') {
      return mockRunState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

/** A completed run as the orchestrator reports it on sync:execute:response. */
const runResult: SyncExecutionResult = {
  configId: 'cfg-1',
  operationId: 'op-1',
  status: 'success',
  objectResults: [],
  totalProcessed: 120,
  totalSuccess: 118,
  totalFailed: 2,
  totalSkipped: 3,
  duration: 4200,
  timestamp: '2024-01-01T00:00:00Z',
};

/** Converted SyncConfig as returned by the SFDMU importer. */
const sfdmuConfig: Record<string, unknown> = {
  id: 'cfg-1',
  name: 'SFDMU Import',
  description: 'Imported from SFDMU export.json',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  direction: 'source_to_target',
  mode: 'full',
  objects: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      externalIdField: 'External_Id__c',
      fieldMappings: [{ sourceField: 'a', targetField: 'b', type: 'rename' }],
      transformRules: [],
      excludedFields: ['CreatedDate'],
      addOnFields: [],
      batchSize: 200,
      insertOrder: 1,
    },
    {
      objectApiName: 'Contact',
      operation: 'insert',
      fieldMappings: [],
      transformRules: [],
      excludedFields: [],
      addOnFields: [],
      batchSize: 200,
      insertOrder: 2,
    },
  ],
  conflictStrategy: 'source_wins',
  enableRollback: false,
  dryRun: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('MigrationPage', () => {
  beforeEach(() => {
    mockSfdmuMutate.mockClear();
    mockSfdmuReset.mockClear();
    mockUniversalMutate.mockClear();
    mockUniversalReset.mockClear();
    mockSfdmuState = {
      mutate: mockSfdmuMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockSfdmuReset,
    };
    mockUniversalState = {
      mutate: mockUniversalMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockUniversalReset,
    };
  });

  it('should render the page with SFDMU selected by default', () => {
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-page')).toBeDefined();
    expect(screen.getByText('Migration')).toBeDefined();
    expect(screen.getByTestId('migration-type-sfdmu').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('migration-type-universal').getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByText('Only a .json file (SFDMU export.json) is accepted.')).toBeDefined();
  });

  it('should switch to the universal importer and update the extension hint', () => {
    render(<MigrationPage />);
    fireEvent.click(screen.getByTestId('migration-type-universal'));
    expect(screen.getByTestId('migration-type-universal').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('Accepted files: .json or .csv.')).toBeDefined();
    /* Switching type resets both mutations */
    expect(mockSfdmuReset).toHaveBeenCalled();
    expect(mockUniversalReset).toHaveBeenCalled();
  });

  it('should keep the import button disabled while the path is empty', () => {
    render(<MigrationPage />);
    const button = screen.getByTestId('migration-import-btn');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('should reject a relative path with a validation error', () => {
    render(<MigrationPage />);
    fireEvent.change(screen.getByTestId('migration-path-input'), {
      target: { value: 'relative/path/export.json' },
    });
    expect(screen.getByText(/The path must be absolute/)).toBeDefined();
    expect(screen.getByTestId('migration-import-btn').hasAttribute('disabled')).toBe(true);
    expect(mockSfdmuMutate).not.toHaveBeenCalled();
  });

  it('should reject a .csv path for the SFDMU importer', () => {
    render(<MigrationPage />);
    fireEvent.change(screen.getByTestId('migration-path-input'), {
      target: { value: '/home/user/data.csv' },
    });
    expect(screen.getByText(/Unsupported file extension/)).toBeDefined();
    expect(screen.getByTestId('migration-import-btn').hasAttribute('disabled')).toBe(true);
    expect(mockSfdmuMutate).not.toHaveBeenCalled();
  });

  it('should send migration:import-sfdmu with the trimmed absolute path', () => {
    render(<MigrationPage />);
    fireEvent.change(screen.getByTestId('migration-path-input'), {
      target: { value: '  /home/user/sfdmu/export.json  ' },
    });
    fireEvent.click(screen.getByTestId('migration-import-btn'));
    expect(mockSfdmuMutate).toHaveBeenCalledWith({ filePath: '/home/user/sfdmu/export.json' });
    expect(mockUniversalMutate).not.toHaveBeenCalled();
  });

  it('should accept a Windows drive path', () => {
    render(<MigrationPage />);
    fireEvent.change(screen.getByTestId('migration-path-input'), {
      target: { value: 'C:\\projects\\sfdmu\\export.json' },
    });
    fireEvent.click(screen.getByTestId('migration-import-btn'));
    expect(mockSfdmuMutate).toHaveBeenCalledWith({ filePath: 'C:\\projects\\sfdmu\\export.json' });
  });

  it('should send migration:import for a CSV file on the universal importer', () => {
    render(<MigrationPage />);
    fireEvent.click(screen.getByTestId('migration-type-universal'));
    fireEvent.change(screen.getByTestId('migration-path-input'), {
      target: { value: '/home/user/data/accounts.csv' },
    });
    fireEvent.click(screen.getByTestId('migration-import-btn'));
    expect(mockUniversalMutate).toHaveBeenCalledWith({
      filePath: '/home/user/data/accounts.csv',
    });
    expect(mockSfdmuMutate).not.toHaveBeenCalled();
  });

  it('should render the converted config preview on success', () => {
    mockSfdmuState = { ...mockSfdmuState, data: { success: true, config: sfdmuConfig } };
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-result')).toBeDefined();
    expect(screen.getByTestId('migration-objects-count').textContent).toBe('2 objects');
    expect(screen.getByTestId('migration-object-Account')).toBeDefined();
    expect(screen.getByTestId('migration-object-Contact')).toBeDefined();
    expect(screen.getByText('upsert')).toBeDefined();
    expect(screen.getByText('External ID: External_Id__c')).toBeDefined();
    expect(screen.getByTestId('migration-raw-config')).toBeDefined();
  });

  it('should show the detected format badge for a universal import', () => {
    mockUniversalState = {
      ...mockUniversalState,
      data: { success: true, config: sfdmuConfig, detectedFormat: 'csv' },
    };
    render(<MigrationPage />);
    fireEvent.click(screen.getByTestId('migration-type-universal'));
    expect(screen.getByTestId('migration-detected-format').textContent).toContain('csv');
  });

  it('should display the error carried by a failed response payload', () => {
    mockSfdmuState = {
      ...mockSfdmuState,
      data: { success: false, error: 'Invalid import path: not absolute.' },
    };
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-error').textContent).toContain(
      'Invalid import path: not absolute.',
    );
  });

  it('should display a bridge-level error', () => {
    mockSfdmuState = { ...mockSfdmuState, error: 'Request timed out' };
    render(<MigrationPage />);
    expect(screen.getByTestId('migration-error').textContent).toContain('Request timed out');
  });

  it('should show the loading state while importing', () => {
    mockSfdmuState = { ...mockSfdmuState, loading: true };
    render(<MigrationPage />);
    const button = screen.getByTestId('migration-import-btn');
    expect(button.textContent).toBe('Importing…');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('should reset the form and the mutations when starting a new import', () => {
    mockSfdmuState = { ...mockSfdmuState, data: { success: true, config: sfdmuConfig } };
    render(<MigrationPage />);
    fireEvent.change(screen.getByTestId('migration-path-input'), {
      target: { value: '/home/user/sfdmu/export.json' },
    });
    fireEvent.click(screen.getByTestId('migration-reset-btn'));
    expect(mockSfdmuReset).toHaveBeenCalled();
    expect(mockUniversalReset).toHaveBeenCalled();
    expect((screen.getByTestId('migration-path-input') as HTMLInputElement).value).toBe('');
  });
});

describe('MigrationPage — running an imported config', () => {
  beforeEach(() => {
    mockRunMutate.mockClear();
    mockRunReset.mockClear();
    mockRunState = {
      mutate: mockRunMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockRunReset,
    };
    useOrgStore.setState({
      orgs: [
        { id: 'org-a', alias: 'devA', username: 'a@e.com' },
        { id: 'org-b', alias: 'devB', username: 'b@e.com' },
      ] as never,
    });
    mockSfdmuState = {
      mutate: mockSfdmuMutate,
      data: { success: true, config: sfdmuConfig },
      loading: false,
      error: null,
      reset: mockSfdmuReset,
    };
  });

  it('runs the imported config against the orgs the user picks', () => {
    // The importer fills sourceOrgId/targetOrgId with UUID placeholders, so an
    // imported config was structurally runnable and pointed at nothing. Before
    // this, the converted config was rendered and dropped on unmount.
    render(<MigrationPage />);

    fireEvent.change(screen.getByTestId('migration-run-source'), { target: { value: 'org-a' } });
    fireEvent.change(screen.getByTestId('migration-run-target'), { target: { value: 'org-b' } });
    fireEvent.click(screen.getByTestId('migration-run-btn'));

    expect(mockRunMutate).toHaveBeenCalledTimes(1);
    const sent = mockRunMutate.mock.calls[0][0] as { config: Record<string, unknown> };
    expect(sent.config.sourceOrgId).toBe('org-a');
    expect(sent.config.targetOrgId).toBe('org-b');
    // The rest of the converted config must survive untouched.
    expect(sent.config.objects).toEqual(sfdmuConfig.objects);
  });

  it('refuses to run into the org it reads from', () => {
    render(<MigrationPage />);

    fireEvent.change(screen.getByTestId('migration-run-source'), { target: { value: 'org-a' } });
    fireEvent.change(screen.getByTestId('migration-run-target'), { target: { value: 'org-a' } });
    fireEvent.click(screen.getByTestId('migration-run-btn'));

    expect(mockRunMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('migration-run-hint')).toBeDefined();
  });

  it('renders nothing about the outcome before the run answers', () => {
    render(<MigrationPage />);
    expect(screen.queryByTestId('migration-run-result')).toBeNull();
    expect(screen.queryByTestId('migration-run-error')).toBeNull();
  });

  it('reports what the run actually moved once the channel answers', () => {
    // WV-12: the run moved records for real and rendered nothing back — the
    // user could not tell whether it had happened, let alone what it did.
    mockRunState = { ...mockRunState, data: runResult };
    render(<MigrationPage />);

    const summary = screen.getByTestId('migration-run-result');
    expect(summary.textContent).toContain('Sync Complete');
    expect(summary.textContent).toContain('Total Processed');
    expect(summary.textContent).toContain('120');
    expect(summary.textContent).toContain('118');
    expect(summary.textContent).toContain('Total Failed');
    expect(summary.textContent).toContain('2');
    expect(summary.textContent).toContain('Total Skipped');
    expect(summary.textContent).toContain('3');
  });

  it('labels a partial run as partial rather than complete', () => {
    mockRunState = {
      ...mockRunState,
      data: { ...runResult, status: 'partial', totalSuccess: 60, totalFailed: 60 },
    };
    render(<MigrationPage />);

    const summary = screen.getByTestId('migration-run-result');
    expect(summary.textContent).toContain('Partially Complete');
    expect(summary.textContent).not.toContain('Sync Complete');
  });

  it('omits the failure and skipped counters when the run reported none', () => {
    mockRunState = {
      ...mockRunState,
      data: { ...runResult, totalFailed: 0, totalSkipped: 0 },
    };
    render(<MigrationPage />);

    const summary = screen.getByTestId('migration-run-result');
    expect(summary.textContent).not.toContain('Total Failed');
    expect(summary.textContent).not.toContain('Total Skipped');
  });

  it('surfaces the failure the sync:error channel settles the run with', () => {
    mockRunState = { ...mockRunState, error: 'Operation blocked by Production Guard' };
    render(<MigrationPage />);

    const banner = screen.getByTestId('migration-run-error');
    expect(banner.textContent).toContain('Operation blocked by Production Guard');
    expect(screen.queryByTestId('migration-run-result')).toBeNull();
  });

  it('dismissing the run failure resets the run mutation', () => {
    mockRunState = { ...mockRunState, error: 'Sync failed: target org unreachable' };
    render(<MigrationPage />);

    fireEvent.click(screen.getByTestId('migration-run-error').querySelector('button')!);
    expect(mockRunReset).toHaveBeenCalled();
  });

  it('does not present the previous outcome while a new run is in flight', () => {
    mockRunState = { ...mockRunState, data: runResult, loading: true };
    render(<MigrationPage />);

    expect(screen.queryByTestId('migration-run-result')).toBeNull();
    expect(screen.getByTestId('migration-run-btn').textContent).toBe('Running…');
  });
});
