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

  it('says which statuses were applied after insert, and which were refused', () => {
    // An activated order is created as a draft and activated once its items
    // are in; a refusal there has to show, not vanish into the counts.
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed-with-errors',
        orgId: 'org-2',
        mode: { pilot: false, reload: false },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 1_000,
        alignment: {
          excludedObjects: [],
          removals: [],
          adjustments: [],
          recordTypeIssues: [],
        },
        placeholders: [],
        requiredDefaults: [],
        perObject: [],
        pass2: { resolved: 0, unresolved: [] },
        personContact: { restored: 0, unresolved: [] },
        statuses: {
          restored: 2,
          refused: [
            {
              objectApiName: 'Order',
              referenceId: 'Order-000003',
              status: 'Activated',
              detail: 'An order must include at least one product.',
            },
          ],
        },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);
    const statuses = screen.getByTestId('frozen-report-statuses');
    expect(statuses.textContent).toContain('Statuses applied after insert: 2 — refused: 1');
    expect(statuses.textContent).toContain('Order-000003 → Activated');
  });

  it('names the records the load left out because the platform writes them itself', () => {
    // A tracked change is never sent — the platform refuses one from a copy —
    // and neither inserted nor failed, it would count nowhere else.
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed',
        orgId: 'org-2',
        mode: { pilot: false, reload: false },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 1_000,
        alignment: {
          excludedObjects: [],
          removals: [],
          adjustments: [],
          recordTypeIssues: [],
        },
        placeholders: [],
        requiredDefaults: [],
        perObject: [],
        pass2: { resolved: 0, unresolved: [] },
        personContact: { restored: 0, unresolved: [] },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        leftToThePlatform: [
          { objectApiName: 'FeedItem', count: 2, note: '2 tracked changes left out' },
          { objectApiName: 'FeedComment', count: 1, note: '1 left out' },
        ],
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);
    const leftOut = screen.getByTestId('frozen-report-left-to-the-platform');
    expect(leftOut.textContent).toContain('the platform writes these records');
    expect(leftOut.textContent).toContain('FeedItem (2), FeedComment (1)');
  });

  it('names each object the load did not send, and why', () => {
    // An object the target takes no insert of makes the load one with errors;
    // with no failed record to show, the report said nothing of which.
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed-with-errors',
        orgId: 'org-2',
        mode: { pilot: true, reload: false },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 1_000,
        alignment: {
          excludedObjects: [
            {
              objectApiName: 'RevenueTransactionErrorLog',
              reason: 'Not createable in target org: 1 record of the dataset not loaded',
            },
          ],
          removals: [],
          adjustments: [],
          recordTypeIssues: [],
        },
        placeholders: [],
        requiredDefaults: [],
        perObject: [],
        pass2: { resolved: 0, unresolved: [] },
        personContact: { restored: 0, unresolved: [] },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);
    const excluded = screen.getByTestId('frozen-report-excluded');
    expect(excluded.textContent).toContain('Objects not loaded');
    expect(excluded.textContent).toContain(
      'RevenueTransactionErrorLog: Not createable in target org: 1 record of the dataset not loaded',
    );
  });

  it('says which feed items a dataset without their type could not load, and to extract it again', () => {
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed',
        orgId: 'org-2',
        mode: { pilot: false, reload: false },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 1_000,
        alignment: {
          excludedObjects: [],
          removals: [],
          adjustments: [],
          recordTypeIssues: [],
        },
        placeholders: [],
        requiredDefaults: [],
        perObject: [],
        pass2: { resolved: 0, unresolved: [] },
        personContact: { restored: 0, unresolved: [] },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        untypedFeedItems: [
          { objectApiName: 'FeedItem', count: 3, note: '3 feed items left out' },
          { objectApiName: 'FeedComment', count: 1, note: '1 left out' },
        ],
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);
    const untyped = screen.getByTestId('frozen-report-untyped-feed-items');
    expect(untyped.textContent).toContain('extract the dataset again');
    expect(untyped.textContent).toContain('FeedItem (3), FeedComment (1)');
    expect(screen.queryByTestId('frozen-report-left-to-the-platform')).toBeNull();
    expect(screen.queryByTestId('frozen-report-excluded')).toBeNull();
  });

  it('says why records failed: per object, each status code and message, with how many', () => {
    // The report counted the failed records and never said why: the reasons
    // were in the report the page held, and nowhere on it.
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed-with-errors',
        orgId: 'org-2',
        mode: { pilot: false, reload: false },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 1_000,
        alignment: {
          excludedObjects: [],
          removals: [],
          adjustments: [],
          recordTypeIssues: [],
        },
        placeholders: [],
        requiredDefaults: [],
        perObject: [
          {
            objectApiName: 'Contact',
            fromFiles: 3,
            inserted: 0,
            reused: 0,
            skippedDuplicates: [],
            failed: ['Contact-000001', 'Contact-000002', 'Contact-000003'].map((referenceId) => ({
              objectApiName: 'Contact',
              referenceId,
              errors: [
                referenceId === 'Contact-000003'
                  ? 'INVALID_EMAIL_ADDRESS: Email: invalid email address'
                  : 'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
              ],
            })),
          },
        ],
        pass2: { resolved: 0, unresolved: [] },
        personContact: { restored: 0, unresolved: [] },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);
    const failures = screen.getByTestId('frozen-report-failures');
    expect(failures.textContent).toContain('Why records failed');
    const rows = Array.from(failures.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ['Contact', 'REQUIRED_FIELD_MISSING', 'Required fields are missing: [LastName]', '2'],
      ['Contact', 'INVALID_EMAIL_ADDRESS', 'Email: invalid email address', '1'],
    ]);
  });

  it('shows no failure reasons for a load where no record failed', () => {
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed',
        orgId: 'org-2',
        mode: { pilot: false, reload: false },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 1_000,
        alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
        placeholders: [],
        requiredDefaults: [],
        perObject: [
          {
            objectApiName: 'Contact',
            fromFiles: 1,
            inserted: 1,
            reused: 0,
            skippedDuplicates: [],
            failed: [],
          },
        ],
        pass2: { resolved: 0, unresolved: [] },
        personContact: { restored: 0, unresolved: [] },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);
    expect(screen.getByTestId('frozen-load-report')).toBeDefined();
    expect(screen.queryByTestId('frozen-report-failures')).toBeNull();
    // A load without Reload purges nothing, and says nothing of a purge.
    expect(screen.queryByTestId('frozen-report-purge')).toBeNull();
  });

  it('says what a reload purged of earlier loads, what it left in place, and why the target kept the rest', () => {
    // A reload whose only errors were in its purge read "Completed with
    // errors" over a report that named none: the purge was counted nowhere.
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed-with-errors',
        orgId: 'org-2',
        mode: { pilot: false, reload: true },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 1_000,
        alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
        placeholders: [],
        requiredDefaults: [],
        perObject: [
          {
            objectApiName: 'Case',
            fromFiles: 2,
            inserted: 2,
            reused: 0,
            skippedDuplicates: [],
            failed: [],
          },
        ],
        pass2: { resolved: 0, unresolved: [] },
        personContact: { restored: 0, unresolved: [] },
        purge: {
          deleted: { Contact: 2, Account: 1 },
          deactivated: { Product2: 1 },
          failures: [
            ...['500000000000001AAA', '500000000000002AAA'].map((recordId) => ({
              objectApiName: 'Case',
              recordId,
              errors: ['DELETE_FAILED: Your attempt to delete this record failed'],
            })),
            {
              objectApiName: 'Order',
              recordId: '801000000000001AAA',
              errors: [
                'Status set to Draft for the purge, and left there: Activated could not be given back — INVALID_STATUS',
              ],
            },
          ],
          leftUnrecorded: { Account: 3 },
        },
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);

    const purge = screen.getByTestId('frozen-report-purge');
    expect(purge.textContent).toContain('What the reload purged of earlier loads');
    const rowsOf = (table: Element): Array<Array<string | null>> =>
      Array.from(table.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent),
      );
    const [purged] = Array.from(purge.querySelectorAll('table'));
    expect(rowsOf(purged)).toEqual([
      ['Contact', '2', '0'],
      ['Account', '1', '0'],
      ['Product2', '0', '1'],
    ]);
    expect(screen.getByTestId('frozen-report-purge-left').textContent).toContain('Account (3)');
    const failures = screen.getByTestId('frozen-report-purge-failures');
    expect(failures.textContent).toContain('Why records could not be purged');
    expect(rowsOf(failures)).toEqual([
      ['Case', 'DELETE_FAILED', 'Your attempt to delete this record failed', '2'],
      [
        'Order',
        '—',
        'Status set to Draft for the purge, and left there: Activated could not be given back — INVALID_STATUS',
        '1',
      ],
    ]);
    // Records of earlier loads, not of this dataset: the load's own failures stay apart.
    expect(screen.queryByTestId('frozen-report-failures')).toBeNull();
  });

  it('names the links the load left unresolved, by object and lookup, with what each cost', () => {
    // Counted nowhere on screen, where the resolved ones were: a load whose
    // only errors were its unresolved links read "Completed with errors" over
    // a report that named none.
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed-with-errors',
        orgId: 'org-2',
        mode: { pilot: false, reload: false },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 1_000,
        alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
        placeholders: [],
        requiredDefaults: [],
        perObject: [
          {
            objectApiName: 'Case',
            fromFiles: 4,
            inserted: 3,
            reused: 0,
            skippedDuplicates: [],
            failed: [
              {
                objectApiName: 'Case',
                referenceId: 'Case-000004',
                errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Subject is required'],
              },
            ],
          },
        ],
        pass2: {
          resolved: 5,
          unresolved: [
            ...['Case-000001', 'Case-000002'].map((referenceId) => ({
              objectApiName: 'Case',
              referenceId,
              field: 'ParentId',
              cause: 'target-not-loaded' as const,
              detail: 'referenced record Case-000004 was not loaded (skipped, failed or excluded)',
            })),
            {
              objectApiName: 'Case',
              referenceId: 'Case-000004',
              field: 'ParentId',
              cause: 'record-not-loaded',
              detail: 'child record was not loaded (see perObject failures/skips)',
            },
            {
              objectApiName: 'Account',
              referenceId: 'Account-000003',
              field: 'ParentId,PrimaryContact__c',
              cause: 'update-refused',
              detail: 'FIELD_INTEGRITY_EXCEPTION: The parent account is merged',
            },
          ],
        },
        personContact: {
          restored: 1,
          unresolved: [
            {
              accountReferenceId: 'Account-000002',
              contactReferenceId: 'Contact-000002',
              cause: 'update-refused',
              detail:
                'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: PersonContactId',
            },
          ],
        },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);

    // Counted where the resolved ones are, lookup by lookup as they are.
    expect(screen.getByTestId('frozen-report-postload').textContent).toBe(
      'Pass 2: 5 cycle links resolved, 5 unresolved — PersonContact: 1 restored, 1 unresolved',
    );
    const unresolved = screen.getByTestId('frozen-report-unresolved');
    expect(unresolved.textContent).toContain('Links the load left unresolved');
    // Per object and lookup, the lookups left empty on records the load
    // wrote, and why: a refused update of two lookups leaves both.
    expect(
      Array.from(unresolved.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent),
      ),
    ).toEqual([
      ['Account', 'ParentId', 'FIELD_INTEGRITY_EXCEPTION: The parent account is merged', '1'],
      [
        'Account',
        'PersonContactId',
        'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: PersonContactId',
        '1',
      ],
      [
        'Account',
        'PrimaryContact__c',
        'FIELD_INTEGRITY_EXCEPTION: The parent account is merged',
        '1',
      ],
      ['Case', 'ParentId', 'The record it points at was not loaded', '2'],
    ]);
    // A link whose own record the load did not write left nothing empty: it
    // went with the record, which the failures name.
    expect(screen.getByTestId('frozen-report-unresolved-lost').textContent).toBe(
      'Lost with the records holding them, which the load did not write: Case.ParentId (1)',
    );
  });

  it('says nothing of unresolved links when the load resolved them all', () => {
    useFrozenStore.setState({
      tab: 'load',
      status: statusFixture(),
      loadReport: {
        status: 'completed',
        orgId: 'org-2',
        mode: { pilot: false, reload: false },
        startedAt: '2026-08-01T11:00:00Z',
        durationMs: 1_000,
        alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
        placeholders: [],
        requiredDefaults: [],
        perObject: [],
        pass2: { resolved: 2, unresolved: [] },
        personContact: { restored: 1, unresolved: [] },
        purge: { deleted: {}, deactivated: {}, failures: [] },
        mappingPath: '/tmp/sas/referenceid-mapping.json',
        contractPath: '/tmp/sas/counting-contract.json',
      },
    });
    render(<FrozenPage />);

    expect(screen.getByTestId('frozen-report-postload').textContent).toBe(
      'Pass 2: 2 cycle links resolved, 0 unresolved — PersonContact: 1 restored, 0 unresolved',
    );
    expect(screen.queryByTestId('frozen-report-unresolved')).toBeNull();
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

  describe('salt fingerprint', () => {
    it('warns when the salt in the environment is not the one the dataset was built with', () => {
      // The page showed only the environment's fingerprint and never compared
      // it with the dataset's. A load replays the files as they are and never
      // reads the salt: the next extraction is what the other salt changes.
      useFrozenStore.setState({
        status: statusFixture({ salt: { present: true, fingerprint: '0123456789ab' } }),
      });
      render(<FrozenPage />);

      const warning = screen.getByTestId('frozen-salt-mismatch').textContent ?? '';
      expect(warning).toContain('0123456789ab');
      expect(warning).toContain('abc123def456');
      expect(warning).toMatch(/extraction/i);
      expect(warning).not.toMatch(/\bload/i);
    });

    it('says nothing when the two fingerprints match', () => {
      useFrozenStore.setState({ status: statusFixture() });
      render(<FrozenPage />);

      expect(screen.queryByTestId('frozen-salt-mismatch')).toBeNull();
    });

    it('says nothing when there is no salt or no dataset to compare', () => {
      useFrozenStore.setState({
        status: statusFixture({ salt: { present: false }, manifest: null }),
      });
      render(<FrozenPage />);

      expect(screen.queryByTestId('frozen-salt-mismatch')).toBeNull();
    });
  });
});
