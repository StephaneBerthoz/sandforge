import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';

const mockPostMessage = vi.fn();

/** Stable identity so useSendMessage's useCallback does not re-fire. */
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { SyncHistoryDetail } from './SyncHistoryDetail';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';
import type { SyncHistoryEntry } from '@sandforge/shared';

const makeMockEntry = (): SyncHistoryEntry => ({
  id: 'h-1',
  configSnapshot: {
    id: 'cfg-1',
    name: 'My Sync Config',
    description: 'Test sync config',
    sourceOrgId: 'org-1',
    targetOrgId: 'org-2',
    direction: 'source_to_target',
    mode: 'full',
    conflictStrategy: 'source_wins',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        fieldMappings: [{ sourceField: 'Name', targetField: 'Name', type: 'direct' }],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        batchSize: 200,
        insertOrder: 0,
      },
    ],
    enableRollback: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  result: {
    configId: 'cfg-1',
    operationId: 'op-1',
    status: 'partial',
    objectResults: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        processed: 100,
        success: 90,
        failed: 8,
        skipped: 2,
        conflictCount: 0,
        errors: ['Row 55: duplicate value', 'Row 72: required field missing'],
      },
      {
        objectApiName: 'Contact',
        operation: 'upsert',
        processed: 50,
        success: 50,
        failed: 0,
        skipped: 0,
        conflictCount: 0,
        errors: [],
      },
    ],
    totalProcessed: 150,
    totalSuccess: 140,
    totalFailed: 8,
    totalSkipped: 2,
    duration: 12000,
    timestamp: '2024-01-01T00:12:00Z',
  },
  startTime: '2024-01-01T00:00:00Z',
  endTime: '2024-01-01T00:12:00Z',
  triggeredBy: 'manual',
});

describe('SyncHistoryDetail', () => {
  beforeEach(() => {
    useSyncHistoryStore.setState({
      entries: [],
      selectedEntry: null,
      loading: false,
      error: null,
    });
  });

  it('asks, before Run again, what the last run between the orgs left of the objects it inserts', () => {
    mockPostMessage.mockClear();
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry() });
    render(<SyncHistoryDetail />);

    const asked = mockPostMessage.mock.calls
      .map((call) => (call[0] as { payload: { type: string; payload: unknown } }).payload)
      .filter((message) => message.type === 'sync:earlier-copies');
    expect(asked.map((message) => message.payload)).toEqual([
      { sourceOrgId: 'org-1', targetOrgId: 'org-2', objects: ['Account'], configId: 'cfg-1' },
    ]);
  });

  it('says what an object left as an earlier run of the configuration copied it', () => {
    const entry = makeMockEntry();
    entry.result.objectResults[0] = { ...entry.result.objectResults[0], alreadyCopied: 2 };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    expect(screen.getByTestId('history-copied-Account').textContent).toBe(
      '2 records already copied by an earlier run of this configuration, left as they were.',
    );
  });

  it('should render nothing when no entry is selected', () => {
    const { container } = render(<SyncHistoryDetail />);
    expect(container.innerHTML).toBe('');
  });

  it('should render entry summary with status and total counts', () => {
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry() });
    render(<SyncHistoryDetail />);
    expect(screen.getByTestId('sync-history-detail')).toBeDefined();
    // Check summary counts
    expect(screen.getByText('150')).toBeDefined(); // totalProcessed
    expect(screen.getByText('140')).toBeDefined(); // totalSuccess
    expect(screen.getByText('8')).toBeDefined(); // totalFailed
  });

  it('says the rows an object wrote in another currency as the currencies they went in, not as errors', () => {
    // Said in English among the object's errors, in their colour, whatever
    // the user's language: a GBP opportunity written in USD read as a failure.
    const entry = makeMockEntry();
    entry.result.objectResults[1] = {
      ...entry.result.objectResults[1],
      objectApiName: 'Opportunity',
      currenciesReplaced: [
        {
          objectApiName: 'Opportunity',
          from: 'GBP',
          to: 'USD',
          chosenBy: 'corporate',
          rows: 1,
          fields: ['Amount'],
          datedBy: 'CloseDate',
        },
      ],
    };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    const rows = screen.getAllByTestId('forge-results-currencies-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      "Opportunity — 1 row in GBP, written in USD, the target org's corporate currency — " +
        "amounts converted at the source org's rates: Amount — at the dated rates of CloseDate",
    ]);
    expect(rows[0].closest('.text-status-error')).toBeNull();
  });

  it('says the prices read in a currency the target lacks apart from the refusals', () => {
    // Listed among the object's errors, "2 GBP → USD: price(s) … replaced …"
    // showed in red as a refusal of the prices.
    const entry = makeMockEntry();
    entry.result.objectResults[1] = {
      ...entry.result.objectResults[1],
      objectApiName: 'PricebookEntry',
      errors: [],
      pricesSettled: [{ from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 2 }],
    };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    const rows = screen.getAllByTestId('results-price-currencies-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      "2 prices in GBP, replaced by the source org's own price in USD for the same product and " +
        'price book, and linked to its copy',
    ]);
    expect(rows[0].closest('.text-status-error')).toBeNull();
    expect(screen.queryByTestId('sync-history-errors-PricebookEntry')).toBeNull();
  });

  it('says the standard price book matched beside the price books, not among their refusals', () => {
    // Listed among the price books' errors, "The standard price book is
    // matched to the target org's, never written." showed in red.
    const entry = makeMockEntry();
    entry.result.objectResults[1] = {
      ...entry.result.objectResults[1],
      objectApiName: 'Pricebook2',
      errors: [],
      standardPricebookMatched: true,
    };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    const line = screen.getByTestId('history-pricebook-Pricebook2');
    expect(line.textContent).toBe(
      "Standard price book: matched to the target org's, never written.",
    );
    expect(line.closest('.text-status-error')).toBeNull();
    expect(screen.queryByTestId('sync-history-errors-Pricebook2')).toBeNull();
  });

  it('says the emails and phone numbers the run neutralized, and the rows linked or written without a lookup, not among the refusals', () => {
    const entry = makeMockEntry();
    entry.result.objectResults[1] = {
      ...entry.result.objectResults[1],
      errors: [],
      linkedToExisting: { records: 2, refusal: 'DUPLICATE_VALUE: duplicate value found' },
      lookupsLeftOut: [{ records: 5, fields: ['OwnerId'], reason: 'notInTarget' }],
    };
    entry.result.contactPoints = {
      neutralized: true,
      fields: [{ objectApiName: 'Contact', field: 'Phone', kind: 'phone', values: 50 }],
      values: 50,
    };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    expect(screen.getByTestId('forge-results-contact-points-row').textContent).toBe(
      'Contact.Phone — 50 values',
    );
    const written = screen.getByTestId('history-written-Contact');
    expect(written.textContent).toContain(
      '2 records linked to records the target org already holds',
    );
    expect(written.textContent).toContain('5 records written without OwnerId');
    expect(written.closest('.text-status-error')).toBeNull();
    expect(screen.queryByTestId('sync-history-errors-Contact')).toBeNull();
  });

  it('says what its runs did with a record the target held, not a direction no run took', () => {
    // "Bidirectional" read as a run writing both ways: every run writes to
    // the target, and on any other direction the strategy was never read.
    const entry = makeMockEntry();
    entry.configSnapshot = {
      ...entry.configSnapshot,
      direction: 'bidirectional',
      conflictStrategy: 'merge',
      objects: entry.configSnapshot.objects.map((o) => ({
        ...o,
        operation: 'upsert',
        externalIdField: 'Ext__c',
      })),
    };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    const { unmount } = render(<SyncHistoryDetail />);

    expect(screen.getByTestId('history-held-records').textContent).toBe(
      "When the target already holds the record: Take the source's values, keeping the " +
        "target's where the source has none.",
    );
    expect(screen.getByTestId('sync-history-detail').textContent).not.toContain('Bidirectional');
    unmount();

    // A configuration that only inserts finds no record to settle.
    const inserting = makeMockEntry();
    inserting.configSnapshot = {
      ...inserting.configSnapshot,
      direction: 'bidirectional',
      objects: inserting.configSnapshot.objects.map((o) => ({ ...o, operation: 'insert' })),
    };
    useSyncHistoryStore.setState({ selectedEntry: inserting });
    render(<SyncHistoryDetail />);
    expect(screen.queryByTestId('history-held-records')).toBeNull();
  });

  it('calls a run a cancel stopped cancelled, not partial, and says before what', () => {
    const entry = makeMockEntry();
    entry.result = {
      ...entry.result,
      cancelled: true,
      error: 'Cancelled before Opportunity was synced.',
    };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    const detail = screen.getByTestId('sync-history-detail');
    expect(detail.textContent).toContain('Cancelled');
    expect(detail.textContent).not.toContain('Partial');
    expect(detail.textContent).toContain('Cancelled before Opportunity was synced.');
  });

  it('opens a run whose stored times are not dates, and says they are unknown', () => {
    // Formatting one threw "Invalid time value": the detail did not open.
    const entry = { ...makeMockEntry(), startTime: 'not a date', endTime: 'neither' };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    const detail = screen.getByTestId('sync-history-detail');
    expect(detail.textContent).toContain('unknown');
    expect(detail.textContent).toContain('Ended at: unknown');
    expect(screen.getByText('150')).toBeDefined();
  });

  it('should render per-object result rows', () => {
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry() });
    render(<SyncHistoryDetail />);
    expect(screen.getByTestId('object-result-Account')).toBeDefined();
    expect(screen.getByTestId('object-result-Contact')).toBeDefined();
  });

  it('should render error messages for objects with errors', () => {
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry() });
    render(<SyncHistoryDetail />);
    expect(screen.getByText(/Row 55: duplicate value/)).toBeDefined();
    expect(screen.getByText(/Row 72: required field missing/)).toBeDefined();
  });

  it('groups the refusals it kept by reason, with what each means and what to do, and says it kept the first ones', () => {
    // A validation rule refusing every record printed one ten-pixel line per
    // record, uncapped, into each of the five hundred entries kept.
    const entry = makeMockEntry();
    entry.result.objectResults[0] = {
      ...entry.result.objectResults[0],
      failed: 800,
      errors: Array.from(
        { length: 50 },
        () => 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33. [Phone]',
      ),
      refusalsDropped: 750,
    };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    const groups = screen.getByTestId('sync-history-errors-Account');
    expect(groups.querySelectorAll('details')).toHaveLength(1);
    expect(groups.querySelector('summary')?.textContent).toBe(
      '50 × FIELD_CUSTOM_VALIDATION_EXCEPTION (Phone)',
    );
    expect(groups.querySelector('[data-testid="error-hint"]')?.textContent).toContain(
      'A validation rule of the org refused the record.',
    );
    expect(screen.getByTestId('sync-history-errors-listed-Account').textContent).toBe(
      'Grouped from the first 50 of the 800 records refused.',
    );
  });

  it('says how a delta run read each object, and what it deleted', () => {
    const entry = makeMockEntry();
    entry.result.objectResults[1] = {
      ...entry.result.objectResults[1],
      delta: {
        read: 'full',
        reason: 'first_run',
        changed: 50,
        deletionsChecked: false,
        deleted: 0,
        deleteFailed: 0,
        recorded: '2026-10-13T09:00:00.000Z',
      },
    };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    expect(screen.getByTestId('history-delta-Contact').textContent).toMatch(
      /^Full read \(first run\) · 50 changed/,
    );
    // A full configuration's object has no such line.
    expect(screen.queryByTestId('history-delta-Account')).toBeNull();
  });

  it("says a pipeline's run was started by a pipeline, not by a schedule", () => {
    useSyncHistoryStore.setState({
      selectedEntry: { ...makeMockEntry(), triggeredBy: 'pipeline' },
    });
    render(<SyncHistoryDetail />);

    expect(screen.getByText(/Triggered by: Pipeline/)).toBeDefined();
  });

  it('says how many files the run copied, and what became of each object’s', () => {
    const entry = makeMockEntry();
    entry.configSnapshot.files = { maxFileSizeMB: 10, maxRunMB: 100 };
    entry.result.objectResults[1] = {
      ...entry.result.objectResults[1],
      files: {
        copied: 2,
        versions: 0,
        bytes: 1_048_576,
        links: 0,
        unchanged: 1,
        tooLarge: 0,
        pastRunCap: 1,
        external: 0,
        recordNotWritten: 0,
        failed: 0,
      },
    };
    useSyncHistoryStore.setState({ selectedEntry: entry });
    render(<SyncHistoryDetail />);

    expect(screen.getByTestId('history-files-summary').textContent).toBe(
      '2 files, 1 MB copied, 1 skipped past the caps',
    );
    expect(screen.getByTestId('history-files-Contact').textContent).toContain(
      '1 skipped: past the most a run copies',
    );
    expect(screen.queryByTestId('history-files-Account')).toBeNull();
  });

  it('should call rerun with correct entryId when Run Again is clicked', () => {
    const rerunSpy = vi.fn();
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry(), rerun: rerunSpy });
    render(<SyncHistoryDetail />);
    fireEvent.click(screen.getByTestId('rerun-btn'));
    expect(rerunSpy).toHaveBeenCalledWith('h-1');
  });

  it('should call clearSelection when close button is clicked', () => {
    const clearSelectionSpy = vi.fn();
    useSyncHistoryStore.setState({
      selectedEntry: makeMockEntry(),
      clearSelection: clearSelectionSpy,
    });
    render(<SyncHistoryDetail />);
    fireEvent.click(screen.getByTestId('detail-close-btn'));
    expect(clearSelectionSpy).toHaveBeenCalled();
  });
});
