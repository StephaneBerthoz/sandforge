import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { FrozenPage } from './FrozenPage';
import { useFrozenStore } from '../../stores/useFrozenStore';
import type { FrozenStatusInfo } from '@sandforge/shared';

/* ---- Mocks ---- */

let mockOrgState: Record<string, unknown> = {
  orgs: [{ id: 'org-1', alias: 'Dev', status: 'connected' }],
  selectedOrgId: 'org-1',
};

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mockOrgState),
}));

const mockNavigate = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: mockNavigate, currentRoute: 'frozen' }),
}));

/** Per-request-type mutation spy: records (requestType, payload) calls. */
const mockMutate = vi.fn();
vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (requestType: string) => ({
    mutate: (payload?: Record<string, unknown>) => mockMutate(requestType, payload),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

/* ---- Fixtures ---- */

function statusFixture(overrides?: Partial<FrozenStatusInfo>): FrozenStatusInfo {
  return {
    configured: true,
    sasDir: '/tmp/sas',
    datasetDir: '/tmp/sas/dataset',
    salt: { present: true, fingerprint: 'abc123def456' },
    mockDetectionConfigured: true,
    selection: null,
    manifest: {
      version: '0.1.0',
      status: 'frozen',
      frozenAt: '2026-08-01T10:00:00Z',
      source: { orgId: 'org-1', decisionDate: '2026-08-01T09:00:00Z' },
      saltFingerprint: 'abc123def456',
      rulesVersion: '1.0.0',
      volumetry: { budgetMax: 2500, measured: { Case: 42 }, measuredAt: '2026-08-01T10:00:00Z' },
      controls: {
        nonReidentification: { passed: true, checks: [], author: 'test', checkedAt: '2026-08-01' },
        dryRunLoad: null,
        author: 'test',
        date: '2026-08-01',
      },
    },
    lastLoad: null,
    lastVerify: null,
    ...overrides,
  };
}

/** Reset the real zustand store between tests. */
function resetStore(): void {
  useFrozenStore.setState({
    tab: 'extract',
    config: null,
    status: null,
    selection: null,
    controlReport: null,
    extractSummary: null,
    manifest: null,
    progress: [],
    loadReport: null,
    verdict: null,
    lastError: null,
  });
}

/* ---- Tests ---- */

describe('FrozenPage', () => {
  beforeEach(() => {
    mockOrgState = {
      orgs: [{ id: 'org-1', alias: 'Dev', status: 'connected' }],
      selectedOrgId: 'org-1',
    };
    mockNavigate.mockClear();
    mockMutate.mockClear();
    resetStore();
  });

  it('shows the empty state when no org is selected', () => {
    mockOrgState = { orgs: [], selectedOrgId: null };
    render(<FrozenPage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
  });

  it('navigates to orgs when the empty-state CTA is clicked', () => {
    mockOrgState = { orgs: [], selectedOrgId: null };
    render(<FrozenPage />);
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(mockNavigate).toHaveBeenCalledWith('orgs');
  });

  it('renders the extract tab by default', () => {
    render(<FrozenPage />);
    expect(screen.getByTestId('frozen-page')).toBeDefined();
    expect(screen.getByTestId('frozen-extract-tab')).toBeDefined();
    expect(screen.getByTestId('frozen-status-strip')).toBeDefined();
  });

  it('switches to the load tab', () => {
    render(<FrozenPage />);
    fireEvent.click(screen.getByTestId('page-tab-load'));
    expect(screen.getByTestId('frozen-load-tab')).toBeDefined();
    expect(screen.queryByTestId('frozen-extract-tab')).toBeNull();
  });

  it('dispatches frozen:config:save with the edited config', () => {
    render(<FrozenPage />);
    fireEvent.change(screen.getByTestId('frozen-config-root-object'), {
      target: { value: 'Case' },
    });
    fireEvent.click(screen.getByTestId('frozen-config-save'));
    expect(mockMutate).toHaveBeenCalledWith(
      'frozen:config:save',
      expect.objectContaining({
        config: expect.objectContaining({ rootObject: 'Case', budgetMaxRecords: 2500 }),
      }),
    );
  });

  it('dispatches frozen:select with the selected org', () => {
    render(<FrozenPage />);
    fireEvent.click(screen.getByTestId('frozen-select-run'));
    expect(mockMutate).toHaveBeenCalledWith('frozen:select', { sourceOrgId: 'org-1' });
  });

  it('dispatches frozen:extract once a selection exists', () => {
    useFrozenStore.setState({
      selection: {
        combinations: [{ combinationKey: 'type=RC', axisValues: { type: 'RC' } }],
        uncovered: [],
        volumetry: { measured: { Case: 1 }, total: 1, budgetMax: 2500 },
        selectedAt: '2026-08-01T09:00:00Z',
        selectionPath: '/tmp/sas/selection.json',
      },
    });
    render(<FrozenPage />);
    fireEvent.click(screen.getByTestId('frozen-extract-run'));
    expect(mockMutate).toHaveBeenCalledWith('frozen:extract', { sourceOrgId: 'org-1' });
  });

  it('renders the retained combinations after a selection', () => {
    useFrozenStore.setState({
      selection: {
        combinations: [{ combinationKey: 'type=RC', axisValues: { type: 'RC' } }],
        uncovered: [{ combinationKey: 'type=EXT', reason: 'no healthy candidate' }],
        volumetry: { measured: { Case: 12 }, total: 12, budgetMax: 2500 },
        selectedAt: '2026-08-01T09:00:00Z',
        selectionPath: '/tmp/sas/selection.json',
      },
    });
    render(<FrozenPage />);
    expect(screen.getByTestId('frozen-selection-volumetry')).toBeDefined();
    // 'type=RC' appears both as combination key and as axis value summary
    expect(screen.getAllByText('type=RC').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('frozen-selection-uncovered')).toBeDefined();
  });

  it('renders the 4-point control result with per-check badges', () => {
    useFrozenStore.setState({
      controlReport: {
        passed: false,
        author: 'test',
        checkedAt: '2026-08-01T10:00:00Z',
        checks: [
          { name: 'substitution', passed: true, violations: [] },
          {
            name: 'clear-empty',
            passed: false,
            violations: [
              {
                check: 'clear-empty',
                objectApiName: 'Case',
                referenceId: 'Case-000001',
                field: 'Description',
                detail: 'residual value under "clear" generator (value redacted at the bridge)',
              },
            ],
          },
          { name: 'formats', passed: true, violations: [] },
          { name: 'no-residual-id', passed: true, violations: [] },
        ],
      },
    });
    render(<FrozenPage />);
    const result = screen.getByTestId('frozen-control-result');
    expect(result).toBeDefined();
    // 3 PASS + 1 FAIL badges across the check table (plus the global FAIL badge)
    expect(screen.getAllByText('FAIL').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('PASS').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Case-000001')).toBeDefined();
  });

  it('dispatches frozen:load with the pilot flag', () => {
    useFrozenStore.setState({ tab: 'load', status: statusFixture() });
    render(<FrozenPage />);
    fireEvent.click(screen.getByTestId('frozen-load-pilot'));
    fireEvent.click(screen.getByTestId('frozen-load-run'));
    expect(mockMutate).toHaveBeenCalledWith('frozen:load', {
      targetOrgId: 'org-1',
      pilot: true,
    });
  });

  it('shows per-phase progress during a load', () => {
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      progress: [
        { phase: 'guards', status: 'done', progress: 5, message: 'Guards OK' },
        {
          phase: 'insert',
          status: 'started',
          progress: 40,
          message: 'Inserting',
          objectName: 'Case',
        },
      ],
    });
    render(<FrozenPage />);
    expect(screen.getByTestId('frozen-load-progress')).toBeDefined();
    expect(screen.getByText(/Inserting/)).toBeDefined();
  });

  it('renders the load report with removals and skipped duplicates', () => {
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed-with-errors',
        orgId: 'org-2',
        mode: { pilot: false, reload: false },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 61_000,
        alignment: {
          excludedObjects: [],
          removals: [
            {
              objectApiName: 'Case',
              field: 'LegacyField__c',
              reason: 'not-in-target',
              affectedRecords: 3,
            },
          ],
          adjustments: [],
          recordTypeIssues: [],
        },
        placeholders: [],
        requiredDefaults: [],
        perObject: [
          {
            objectApiName: 'Case',
            fromFiles: 10,
            inserted: 8,
            reused: 1,
            skippedDuplicates: [
              {
                objectApiName: 'Case',
                referenceId: 'Case-000007',
                errors: ['DUPLICATES_DETECTED'],
              },
            ],
            failed: [],
          },
        ],
        pass2: { resolved: 2, unresolved: [] },
        personContact: { restored: 1, unresolved: [] },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);
    expect(screen.getByTestId('frozen-load-report')).toBeDefined();
    expect(screen.getByTestId('frozen-report-removals')).toBeDefined();
    expect(screen.getByText('Case.LegacyField__c')).toBeDefined();
    expect(screen.getByTestId('frozen-report-skipped')).toBeDefined();
    expect(screen.getByText('Case-000007')).toBeDefined();
  });

  it('renders the post-load verdict', () => {
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      verdict: {
        status: 'passed',
        checks: [
          { name: 'stability', passed: true, detail: 'two identical snapshots' },
          { name: 'counts', passed: true, detail: 'all objects match' },
        ],
        attempts: 2,
        measuredAt: '2026-08-01T11:05:00Z',
      },
    });
    render(<FrozenPage />);
    expect(screen.getByTestId('frozen-verify-result')).toBeDefined();
    expect(screen.getByText('stability')).toBeDefined();
    expect(screen.getByText('counts')).toBeDefined();
  });
});
