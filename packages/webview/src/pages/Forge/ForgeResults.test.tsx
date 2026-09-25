import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import type { BaseMessage, ForgeConfig, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { ForgeResults, ID_REMAP_VIRTUALIZE_THRESHOLD } from './ForgeResults';

/* ---- Mocks ---- */

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

/** The payloads of every message of `type` the screen posted. */
function sent<T>(type: string): T[] {
  return mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage & { payload: T } })
    .filter((envelope) => envelope.payload.type === type)
    .map((envelope) => envelope.payload.payload);
}

/** Answer the last `requestType` message on `responseType`, correlated as a handler does. */
function replyTo(requestType: string, responseType: string, payload: unknown): void {
  const request = mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage })
    .filter((envelope) => envelope.payload.type === requestType)
    .pop();
  if (!request) throw new Error(`no '${requestType}' message was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${responseType}`,
          type: responseType,
          timestamp: Date.now(),
          correlationId: request.payload.id,
          payload,
        },
      }),
    );
  });
}

const mockUpsertTemplate = vi.fn();

/** The configuration the run on screen was started with. */
const RUN_CONFIG: ForgeConfig = {
  inputMode: 'soql',
  soqlQuery: "SELECT Id FROM Account WHERE Industry = 'Energy'",
  objectSoqlFilters: { Account: "Industry = 'Energy'" },
  depth: 'full',
  maxNodes: 200,
  sourceOrgId: 'org-source',
  targetOrgId: 'org-target',
  anonymizePII: true,
  skipEmpty: false,
  batchSize: 'auto',
  maxRecordsPerObject: 200,
};

const RUN_RULES = {
  email: 'hash',
  phone: 'mask',
  name: 'fake',
  address: 'fake',
  ssn_id: 'redact',
  financial: 'hash',
  other: 'nullify',
} as const;

/**
 * Mock @tanstack/react-virtual: jsdom has no layout, so the real virtualizer
 * measures a zero-height scroll container and yields no rows at all. This
 * stand-in yields a fixed window (10 visible + overscan on both sides), which
 * is what makes "renders a window, not the whole list" observable in a test.
 */
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number; overscan?: number }) => {
    const rowHeight = opts.estimateSize();
    const overscan = opts.overscan ?? 5;
    const visibleCount = Math.min(opts.count, 10 + overscan * 2);
    const items = Array.from({ length: visibleCount }, (_, i) => ({
      index: i,
      start: i * rowHeight,
      size: rowHeight,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * rowHeight,
    };
  },
}));

const mockReset = vi.fn();
const mockForgeAgain = vi.fn();
const mockSetPhase = vi.fn();
const mockSetGraph = vi.fn();

const makeMockGraph = (): ForgeGraph => ({
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 10,
      fieldCount: 15,
      status: 'done' as const,
      progress: 100,
      included: true,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 0,
      successCount: 10,
      failureCount: 0,
      errors: [] as string[],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
    {
      objectApiName: 'Contact',
      recordCount: 20,
      fieldCount: 18,
      status: 'done' as const,
      progress: 100,
      included: true,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 1,
      successCount: 18,
      failureCount: 2,
      errors: ['FIELD_INTEGRITY_EXCEPTION'],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
    {
      objectApiName: 'Case',
      recordCount: 5,
      fieldCount: 10,
      status: 'skipped' as const,
      progress: 0,
      included: false,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 2,
      successCount: 0,
      failureCount: 0,
      errors: [] as string[],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
  ],
  edges: [],
  totalRecords: 35,
  estimatedSizeMB: 1.2,
  estimatedDurationSeconds: 10,
});

const mockLogs = [
  { id: 'log-1', timestamp: Date.now(), level: 'info' as const, message: 'Processing Account' },
  { id: 'log-2', timestamp: Date.now(), level: 'error' as const, message: 'Error on Case' },
];

const makeMockResult = () => ({
  id: 'exec-001',
  startedAt: Date.now() - 10_000,
  completedAt: Date.now(),
  totalRecords: 35,
  totalSuccess: 28,
  totalFailures: 2,
  status: 'partial' as const,
  graph: makeMockGraph(),
  idRemapCount: 42,
  idRemapTable: {} as Record<string, string>,
  truncatedObjects: [] as string[],
  duration: 10000,
  timestamp: '2026-03-20T10:00:00.000Z',
});

const makeErrorNode = (): ForgeGraphNode => ({
  objectApiName: 'Opportunity',
  recordCount: 8,
  fieldCount: 12,
  status: 'error' as const,
  progress: 40,
  included: true,
  piiFields: [] as string[],
  anonymizeFields: ['Email__c'] as string[],
  level: 1,
  successCount: 3,
  failureCount: 5,
  errors: ['UNABLE_TO_LOCK_ROW'],
  createableFieldCount: 0,
  estimatedSizeMB: 0,
  estimatedApiCalls: 5,
  batchStrategy: 'auto' as const,
});

const makeMockGraphWithError = () => {
  const base = makeMockGraph();
  return {
    ...base,
    nodes: [...base.nodes, makeErrorNode()],
    totalRecords: base.totalRecords + 8,
  };
};

let mockGraph = makeMockGraph();
let mockResult = makeMockResult();
/** What the run reported of the objects it adds beyond the graph, by name. */
let mockStatusesBeyondGraph: Record<string, string> = {};
/** The run's choice to copy the files of its records, as Review held it. */
let mockFileCopy = { enabled: false, maxFileSizeMB: 10, acceptedAsIs: false };
/** Why the run shown stopped, when an error ended it, and the run it had written. */
let mockRunError: { message: string; stoppedRun: { forgeId: string } | null } | null = null;
const mockResetNodeStatuses = vi.fn(() => {
  mockGraph = {
    ...mockGraph,
    nodes: mockGraph.nodes.map((n) => ({ ...n, status: 'idle' as const, progress: 0 })),
  };
});
const mockSetExecutionRequestId = vi.fn();

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get graph() {
          return mockGraph;
        },
        get result() {
          return mockResult;
        },
        get statusesBeyondGraph() {
          return mockStatusesBeyondGraph;
        },
        get runError() {
          return mockRunError;
        },
        reset: (...args: unknown[]) => mockReset(...args),
        forgeAgain: (...args: unknown[]) => mockForgeAgain(...args),
        setPhase: (...args: unknown[]) => mockSetPhase(...args),
        setGraph: (...args: unknown[]) => mockSetGraph(...args),
        logs: mockLogs,
        config: RUN_CONFIG,
        anonymizationRules: RUN_RULES,
        anonymizationPresetId: 'preset:gdpr-default',
        upsertTemplate: (...args: unknown[]) => mockUpsertTemplate(...args),
      }),
    {
      getState: () => ({
        graph: mockGraph,
        result: mockResult,
        reset: mockReset,
        forgeAgain: mockForgeAgain,
        setPhase: mockSetPhase,
        setGraph: mockSetGraph,
        logs: mockLogs,
        anonymizationRules: RUN_RULES,
        fileCopy: mockFileCopy,
        resetNodeStatuses: mockResetNodeStatuses,
        setExecutionRequestId: mockSetExecutionRequestId,
      }),
    },
  );
  return { useForgeStore: store };
});

/* ---- Tests ---- */

describe('ForgeResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraph = makeMockGraph();
    mockResult = makeMockResult();
    mockStatusesBeyondGraph = {};
    mockFileCopy = { enabled: false, maxFileSizeMB: 10, acceptedAsIs: false };
    mockRunError = null;
  });

  it('should render with forge-results test id', () => {
    render(<ForgeResults />);
    expect(screen.getByTestId('forge-results')).toBeDefined();
  });

  it('tells a screen reader the clone finished, and what it wrote', () => {
    // The execution screen's announcer unmounts in the same pass that shows
    // the results, so its "complete" message was never spoken.
    render(<ForgeResults />);
    expect(screen.getByTestId('forge-results-status').textContent).toBe(
      'Forge finished. Written: 28 of 35.',
    );
    expect(screen.queryByTestId('forge-results-stopped')).toBeNull();
  });

  it('says a run an error stopped did not finish, and why, above what it had written', () => {
    // Shown from the execution screen's error: what it wrote, read as a
    // finished run's, was taken for the whole clone.
    mockResult = Object.assign(makeMockResult(), { forgeId: 'forge-stopped' });
    mockRunError = {
      message: 'INVALID_SESSION_ID: Session expired or invalid',
      stoppedRun: { forgeId: 'forge-stopped' },
    };
    render(<ForgeResults />);

    expect(screen.getByTestId('forge-results-stopped').textContent).toBe(
      'The run stopped before its end: INVALID_SESSION_ID: Session expired or invalid',
    );
    expect(screen.getByTestId('forge-results-status').textContent).toBe(
      'Forge stopped before its end. Written: 28 of 35.',
    );
  });

  it('should render 6 KPI cards', () => {
    render(<ForgeResults />);
    const cards = screen.getAllByTestId('kpi-card');
    expect(cards.length).toBe(6);
  });

  it('should display correct inserted count in KPI', () => {
    render(<ForgeResults />);
    const values = screen.getAllByTestId('kpi-value');
    // inserted = 10 (Account) + 18 (Contact) + 0 (Case) = 28
    expect(values[0].textContent).toBe('28');
  });

  it('counts the objects the run skipped, not the records discovery counted in their tables', () => {
    // A node's count is discovery's, of its whole table: a clone of one record
    // that skipped a large table read as having skipped every row of it.
    const largeTable: ForgeGraphNode = {
      ...makeMockGraph().nodes[2],
      objectApiName: 'CaseHistory',
      recordCount: 48_000,
    };
    mockGraph = { ...mockGraph, nodes: [...mockGraph.nodes, largeTable] };
    render(<ForgeResults />);

    const card = screen.getAllByTestId('kpi-card')[1];
    expect(card.textContent).toContain('Objects skipped');
    expect(within(card).getByTestId('kpi-value').textContent).toBe('2');
  });

  it('says in the copied report how many objects the run skipped', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    try {
      render(<ForgeResults />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('forge-copy-report'));
      });

      const report = writeText.mock.calls[0]?.[0] ?? '';
      expect(report).toContain('- Objects skipped: 1\n');
      expect(report).not.toContain('- Skipped:');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('should display idRemaps from result.idRemapCount, not inserted', () => {
    render(<ForgeResults />);
    const values = screen.getAllByTestId('kpi-value');
    // idRemaps = result.idRemapCount = 42, NOT inserted count of 28
    expect(values[2].textContent).toBe('42');
  });

  it('should display success rate in KPI', () => {
    render(<ForgeResults />);
    const values = screen.getAllByTestId('kpi-value');
    // successRate = round(28/35*100) = 80%
    expect(values[3].textContent).toBe('80%');
  });

  describe('a run that says what it read', () => {
    /**
     * A record-scoped clone: discovery counted each whole table, and the run
     * read one account and three contacts. Cases were left out.
     */
    function clonedFromLargeTables(): void {
      const [account, contact, cases] = makeMockGraph().nodes;
      mockGraph = {
        ...makeMockGraph(),
        nodes: [
          { ...account, recordCount: 16_000 },
          { ...contact, recordCount: 48_000 },
          { ...cases, recordCount: 9_000 },
        ],
        totalRecords: 73_000,
      };
      mockResult = Object.assign(makeMockResult(), {
        graph: mockGraph,
        createdCount: 3,
        readByObject: [
          { objectApiName: 'Account', read: 1 },
          { objectApiName: 'Contact', read: 3 },
        ],
      });
    }

    /** The Records cell of each row, by object, in the order the table shows them. */
    function recordsColumn(): Array<[string, string]> {
      return screen.getAllByTestId('forge-results-row').map((row) => {
        const cells = row.querySelectorAll('td');
        return [cells[0].textContent ?? '', cells[1].textContent ?? ''];
      });
    }

    it('measures what it wrote against the records it read, not the tables they were cut from', () => {
      clonedFromLargeTables();
      render(<ForgeResults />);

      expect(screen.getByTestId('forge-results-status').textContent).toBe(
        'Forge finished. Written: 3 of 4.',
      );
      const rate = screen.getAllByTestId('kpi-card')[3];
      expect(rate.textContent).toContain('Success Rate');
      expect(within(rate).getByTestId('kpi-value').textContent).toBe('75%');
    });

    it('shows per object the records it read, and none for an object it did not read', () => {
      clonedFromLargeTables();
      render(<ForgeResults />);

      expect(recordsColumn()).toEqual([
        ['Account', '1'],
        ['Case', '-'],
        ['Contact', '3'],
      ]);
    });

    it('sorts the records column by what it read, an object it did not read first', () => {
      clonedFromLargeTables();
      mockResult = Object.assign(mockResult, {
        readByObject: [
          { objectApiName: 'Account', read: 3 },
          { objectApiName: 'Contact', read: 1 },
        ],
      });
      render(<ForgeResults />);

      fireEvent.click(screen.getByTestId('forge-results-sort-records'));

      expect(recordsColumn()).toEqual([
        ['Case', '-'],
        ['Contact', '1'],
        ['Account', '3'],
      ]);
    });

    it('copies the records it read of each object into the report', async () => {
      clonedFromLargeTables();
      const writeText = vi.fn((_text: string) => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
        writable: true,
      });
      try {
        render(<ForgeResults />);
        await act(async () => {
          fireEvent.click(screen.getByTestId('forge-copy-report'));
        });

        const report = writeText.mock.calls[0]?.[0] ?? '';
        expect(report).toContain('| Account | 1 | done | - |');
        expect(report).toContain('| Contact | 3 | done | FIELD_INTEGRITY_EXCEPTION |');
        expect(report).toContain('| Case | - | skipped | - |');
        expect(report).toContain('- Success Rate: 75%');
      } finally {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    });

    it('rates a run that read nothing because each of its reads failed at nothing written', () => {
      clonedFromLargeTables();
      mockResult = Object.assign(mockResult, {
        status: 'failure' as const,
        createdCount: 0,
        readByObject: [],
      });
      render(<ForgeResults />);

      const rate = screen.getAllByTestId('kpi-card')[3];
      expect(within(rate).getByTestId('kpi-value').textContent).toBe('0%');
      expect(screen.getByTestId('forge-results-status').textContent).toBe(
        'Forge finished. Written: 0 of 0.',
      );
    });

    it('rates a run that had nothing to write at all it had to do', () => {
      clonedFromLargeTables();
      mockResult = Object.assign(mockResult, {
        status: 'success' as const,
        createdCount: 0,
        readByObject: [{ objectApiName: 'Account', read: 0 }],
      });
      render(<ForgeResults />);

      const rate = screen.getAllByTestId('kpi-card')[3];
      expect(within(rate).getByTestId('kpi-value').textContent).toBe('100%');
    });

    describe('when the read of an object failed', () => {
      /**
       * The clone of one account and three contacts, all written, whose read
       * of the account's opportunities failed: the run never learned how many
       * its scope held, and ended partial.
       */
      function opportunitiesUnread(): void {
        clonedFromLargeTables();
        mockResult = Object.assign(mockResult, {
          status: 'partial' as const,
          createdCount: 4,
          failedReads: ['Opportunity'],
        });
      }

      /** The note the page gives of the objects it could not read. */
      const NOTE =
        'Could not be read, so not cloned: Opportunity. The success rate counts only the records that were read.';

      it('names them next to the rate, which counts only the records it read', () => {
        opportunitiesUnread();
        render(<ForgeResults />);

        const rate = screen.getAllByTestId('kpi-card')[3];
        expect(within(rate).getByTestId('kpi-value').textContent).toBe('100%');
        const note = screen.getByTestId('forge-results-read-failed');
        expect(note.textContent).toBe(NOTE);
        // Right under the row of figures the rate is one of.
        expect(note.previousElementSibling?.contains(rate)).toBe(true);
      });

      it('never shows the rate as a success', () => {
        opportunitiesUnread();
        render(<ForgeResults />);

        const rate = screen.getAllByTestId('kpi-card')[3];
        const icon = rate.querySelector('.text-status-warning, .text-status-success');
        expect(icon?.className).toContain('text-status-warning');
      });

      it('says so after what it wrote when the run finishes', () => {
        opportunitiesUnread();
        render(<ForgeResults />);

        expect(screen.getByTestId('forge-results-status').textContent).toBe(
          `Forge finished. Written: 4 of 4. ${NOTE}`,
        );
      });

      it('names them next to the rate in the copied report', async () => {
        opportunitiesUnread();
        const writeText = vi.fn((_text: string) => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText },
          configurable: true,
          writable: true,
        });
        try {
          render(<ForgeResults />);
          await act(async () => {
            fireEvent.click(screen.getByTestId('forge-copy-report'));
          });

          const report = writeText.mock.calls[0]?.[0] ?? '';
          expect(report).toContain(
            '- Success Rate: 100%\n- Could not be read (not in the rate): Opportunity\n',
          );
        } finally {
          Reflect.deleteProperty(navigator, 'clipboard');
        }
      });

      it('says nothing of it for a run that read every object it tried', () => {
        clonedFromLargeTables();
        mockResult = Object.assign(mockResult, { createdCount: 4, failedReads: [] });
        render(<ForgeResults />);

        expect(screen.queryByTestId('forge-results-read-failed')).toBeNull();
        const rate = screen.getAllByTestId('kpi-card')[3];
        expect(rate.querySelector('.text-status-success')).not.toBeNull();
        expect(screen.getByTestId('forge-results-status').textContent).toBe(
          'Forge finished. Written: 4 of 4.',
        );
      });
    });

    it('keeps the counts of the graph for a result recorded before the run said what it read', () => {
      render(<ForgeResults />);

      expect(recordsColumn()).toEqual([
        ['Account', '10'],
        ['Case', '5'],
        ['Contact', '20'],
      ]);
      expect(screen.getByTestId('forge-results-status').textContent).toBe(
        'Forge finished. Written: 28 of 35.',
      );
    });
  });

  describe('the objects the table lists', () => {
    /** A node discovery left out: an empty table, unless `errors` says why else. */
    const leftOut = (objectApiName: string, errors: string[] = []): ForgeGraphNode => ({
      ...makeMockGraph().nodes[2],
      objectApiName,
      recordCount: 0,
      // The run reports every node it leaves out as skipped, and the page
      // takes that status: the error is what still tells a failed count.
      status: 'skipped',
      included: false,
      errors,
    });

    /**
     * The clone of one account and its contacts, cases left out: discovery
     * found leads and assets empty, and could not count email statuses. At
     * its cap, it never reached the price book entries the run then added,
     * nor the selling model options; the products could not be read.
     */
    function cloneBeyondItsGraph(): void {
      mockGraph = {
        ...makeMockGraph(),
        nodes: [
          ...makeMockGraph().nodes,
          leftOut('Lead'),
          leftOut('Asset'),
          leftOut('EmailStatus', [
            'Record count unavailable: INVALID_TYPE_FOR_OPERATION: entity type EmailStatus does not support query',
          ]),
        ],
      };
      mockResult = Object.assign(makeMockResult(), {
        graph: mockGraph,
        createdCount: 8,
        readByObject: [
          { objectApiName: 'Account', read: 1 },
          { objectApiName: 'Contact', read: 3 },
          { objectApiName: 'PricebookEntry', read: 2 },
          { objectApiName: 'ProductSellingModelOption', read: 2 },
        ],
        failedReads: ['Product2'],
      });
      mockStatusesBeyondGraph = { PricebookEntry: 'done', ProductSellingModelOption: 'error' };
    }

    /** Each row as the table shows it: object, records, status, errors. */
    function tableRows(): string[][] {
      return screen
        .getAllByTestId('forge-results-row')
        .map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? ''));
    }

    it('gives a row to each object the run read or wrote beyond its graph', () => {
      // The catalog beyond the cap and the selling model options are in the
      // run's counts, its log and its removal: the table had no row for them.
      cloneBeyondItsGraph();
      render(<ForgeResults />);

      expect(tableRows()).toEqual([
        ['Account', '1', 'Done', '-'],
        ['Case', '-', 'Skipped', '-'],
        ['Contact', '3', 'Done', 'FIELD_INTEGRITY_EXCEPTION'],
        [
          'EmailStatus',
          '-',
          'Skipped',
          'Record count unavailable: INVALID_TYPE_FOR_OPERATION: entity type EmailStatus does not support query',
        ],
        ['PricebookEntry', '2', 'Done', '-'],
        ['Product2', '-', 'Failed', '-'],
        ['ProductSellingModelOption', '2', 'Failed', '-'],
      ]);
    });

    it('sorts and filters those rows with the others', () => {
      cloneBeyondItsGraph();
      render(<ForgeResults />);

      fireEvent.change(screen.getByTestId('forge-results-status-filter'), {
        target: { value: 'error' },
      });
      expect(tableRows().map(([object]) => object)).toEqual([
        'Product2',
        'ProductSellingModelOption',
      ]);

      fireEvent.change(screen.getByTestId('forge-results-status-filter'), {
        target: { value: 'all' },
      });
      fireEvent.click(screen.getByTestId('forge-results-sort-records'));
      expect(tableRows().map(([object, records]) => `${object} ${records}`)).toEqual([
        'Case -',
        'EmailStatus -',
        'Product2 -',
        'Account 1',
        'PricebookEntry 2',
        'ProductSellingModelOption 2',
        'Contact 3',
      ]);
    });

    it('lists none of the empty tables discovery left out, and says how many there were', () => {
      cloneBeyondItsGraph();
      render(<ForgeResults />);

      const listed = tableRows().map(([object]) => object);
      expect(listed).not.toContain('Lead');
      expect(listed).not.toContain('Asset');
      expect(screen.getByTestId('forge-results-empty-tables').textContent).toBe(
        'Not listed: 2 objects discovery left out because their table is empty in the source.',
      );
    });

    it('counts among the skipped objects those left out for a reason, not the empty tables', () => {
      cloneBeyondItsGraph();
      render(<ForgeResults />);

      // Cases, left out by choice, and email statuses, which could not be counted.
      const card = screen.getAllByTestId('kpi-card')[1];
      expect(card.textContent).toContain('Objects skipped');
      expect(within(card).getByTestId('kpi-value').textContent).toBe('2');
    });

    it('copies the same rows into the report, and the empty tables in one line', async () => {
      cloneBeyondItsGraph();
      const writeText = vi.fn((_text: string) => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
        writable: true,
      });
      try {
        render(<ForgeResults />);
        await act(async () => {
          fireEvent.click(screen.getByTestId('forge-copy-report'));
        });

        const report = writeText.mock.calls[0]?.[0] ?? '';
        expect(report).toContain('- Objects skipped: 2\n');
        expect(report).toContain('| PricebookEntry | 2 | done | - |');
        expect(report).toContain('| Product2 | - | error | - |');
        expect(report).toContain('| ProductSellingModelOption | 2 | error | - |');
        expect(report).toContain(
          '| EmailStatus | - | skipped | Record count unavailable: INVALID_TYPE_FOR_OPERATION',
        );
        expect(report).not.toContain('| Lead |');
        expect(report).not.toContain('| Asset |');
        // Right under the table.
        expect(report).toContain(
          '| Product2 | - | error | - |\n\nNot listed: 2 objects discovery left out because their table is empty in the source.',
        );
      } finally {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    });

    it('shows an object beyond the graph as done when the run said nothing of it', () => {
      // A result the page holds without the run's reports of that object.
      cloneBeyondItsGraph();
      mockStatusesBeyondGraph = {};
      render(<ForgeResults />);

      const beyond = tableRows().filter(([object]) =>
        ['PricebookEntry', 'Product2', 'ProductSellingModelOption'].includes(object),
      );
      expect(beyond.map(([object, , status]) => `${object} ${status}`)).toEqual([
        'PricebookEntry Done',
        'Product2 Failed',
        'ProductSellingModelOption Done',
      ]);
    });

    it('says nothing of empty tables for a run whose discovery left none out', () => {
      render(<ForgeResults />);
      expect(screen.queryByTestId('forge-results-empty-tables')).toBeNull();
    });
  });

  it('should render results table with correct rows', () => {
    render(<ForgeResults />);
    const table = screen.getByTestId('forge-results-table');
    expect(table).toBeDefined();
    // 3 nodes = 3 data rows
    const rows = table.querySelectorAll('tbody tr');
    expect(rows.length).toBe(3);
  });

  it('should show error text for nodes with errors', () => {
    render(<ForgeResults />);
    expect(screen.getByText('FIELD_INTEGRITY_EXCEPTION')).toBeDefined();
  });

  it('should call forgeAgain (not reset) when forge again button is clicked', () => {
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-again');
    fireEvent.click(btn);
    expect(mockForgeAgain).toHaveBeenCalledTimes(1);
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('should render copy report button', () => {
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-copy-report');
    expect(btn).toBeDefined();
  });

  it('should render save template button', () => {
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-save-template');
    expect(btn).toBeDefined();
  });

  describe('save as template', () => {
    function openForm(): void {
      render(<ForgeResults />);
      fireEvent.click(screen.getByTestId('forge-save-template'));
    }

    function fill(name: string, description = ''): void {
      fireEvent.change(screen.getByTestId('forge-save-template-name'), {
        target: { value: name },
      });
      fireEvent.change(screen.getByTestId('forge-save-template-desc'), {
        target: { value: description },
      });
    }

    beforeEach(() => {
      mockPostMessage.mockClear();
    });

    it('opens a form on its name field, labelled and tied to the button that opened it', () => {
      openForm();

      const button = screen.getByTestId('forge-save-template');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(button.getAttribute('aria-controls')).toBe('forge-save-template-form');
      expect(screen.getByLabelText(i18n.t('forge.templateName'))).toBe(document.activeElement);
      expect(screen.getByLabelText(i18n.t('forge.templateDescription'))).toBeDefined();
    });

    it("sends the run's input, scope, anonymization and target org, and not its source", () => {
      openForm();
      fill('  Energy accounts  ', 'Weekly refresh');

      fireEvent.click(screen.getByTestId('forge-save-template-submit'));

      const [{ template }] = sent<{ template: Record<string, unknown> }>('forge:templates:save');
      expect(template).toMatchObject({
        name: 'Energy accounts',
        description: 'Weekly refresh',
        targetOrgId: 'org-target',
        anonymization: { presetId: 'preset:gdpr-default', rules: RUN_RULES },
        // Account and Contact were included; Case was left out of the run.
        objectCount: 2,
        recordCount: 35,
      });
      expect(template.config).toEqual({
        inputMode: 'soql',
        soqlQuery: "SELECT Id FROM Account WHERE Industry = 'Energy'",
        objectSoqlFilters: { Account: "Industry = 'Energy'" },
        depth: 'full',
        maxNodes: 200,
        anonymizePII: true,
        skipEmpty: false,
        batchSize: 'auto',
        maxRecordsPerObject: 200,
      });
      expect(JSON.stringify(template)).not.toContain('org-source');
    });

    it('keeps with the template the records the run read, not the rows of the tables it read them from', () => {
      mockResult = Object.assign(makeMockResult(), {
        readByObject: [
          { objectApiName: 'Account', read: 1 },
          { objectApiName: 'Contact', read: 3 },
        ],
      });
      openForm();
      fill('Energy accounts');

      fireEvent.click(screen.getByTestId('forge-save-template-submit'));

      const [{ template }] = sent<{ template: Record<string, unknown> }>('forge:templates:save');
      expect(template.recordCount).toBe(4);
    });

    it('lists the template only once the extension answered that it kept it', () => {
      openForm();
      fill('Energy accounts');
      fireEvent.click(screen.getByTestId('forge-save-template-submit'));
      expect(mockUpsertTemplate).not.toHaveBeenCalled();

      replyTo('forge:templates:save', 'forge:templates:save:response', { success: true });

      expect(mockUpsertTemplate).toHaveBeenCalledTimes(1);
      expect(mockUpsertTemplate.mock.calls[0][0].name).toBe('Energy accounts');
      expect(screen.queryByTestId('forge-save-template-form')).toBeNull();
      expect(screen.getByTestId('forge-save-template-saved').textContent).toBe(
        i18n.t('forge.savedTemplate.saved', { name: 'Energy accounts' }),
      );
      // The form and the field that had focus are gone; focus goes back to the button.
      expect(screen.getByTestId('forge-save-template')).toBe(document.activeElement);
    });

    it('sends one save while one is waiting for its answer, however the form is submitted', () => {
      openForm();
      fill('Energy accounts');

      fireEvent.submit(screen.getByTestId('forge-save-template-form'));
      fireEvent.submit(screen.getByTestId('forge-save-template-form'));

      expect(sent('forge:templates:save')).toHaveLength(1);
    });

    it('asks for a name before saving, and sends nothing without one', () => {
      openForm();
      fill('   ');

      fireEvent.click(screen.getByTestId('forge-save-template-submit'));

      expect(sent('forge:templates:save')).toEqual([]);
      const name = screen.getByTestId('forge-save-template-name');
      expect(name.getAttribute('aria-invalid')).toBe('true');
      expect(name.getAttribute('aria-describedby')).toBe('forge-save-template-name-error');
      expect(screen.getByRole('alert').textContent).toBe(
        i18n.t('forge.savedTemplate.nameRequired'),
      );
    });

    it('says why the extension did not keep it, and keeps the form open', () => {
      useNotificationStore.setState({ notifications: [] });
      openForm();
      fill('Energy accounts');
      fireEvent.click(screen.getByTestId('forge-save-template-submit'));

      replyTo('forge:templates:save', 'forge:templates:save:error', {
        message: 'EROFS: read-only file system',
        code: 'UNKNOWN',
        retryable: false,
      });

      expect(screen.getByTestId('forge-save-template-error').textContent).toBe(
        i18n.t('forge.savedTemplate.saveFailed', { message: 'EROFS: read-only file system' }),
      );
      expect(screen.getByTestId('forge-save-template-form')).toBeDefined();
      expect(mockUpsertTemplate).not.toHaveBeenCalled();
    });
  });

  it('should render export JSON button', () => {
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-export-json');
    expect(btn).toBeDefined();
  });

  it('should render retry failed button when failed nodes exist', () => {
    mockGraph = makeMockGraphWithError();
    mockResult = { ...makeMockResult(), graph: mockGraph };
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-retry-failed');
    expect(btn).toBeDefined();
  });

  it('should not render retry failed button when no failed nodes', () => {
    render(<ForgeResults />);
    expect(screen.queryByTestId('forge-retry-failed')).toBeNull();
  });

  describe('Retry failed', () => {
    /** A run that failed its opportunities, as the history names it. */
    function failedRun(): void {
      mockGraph = makeMockGraphWithError();
      mockResult = {
        ...makeMockResult(),
        graph: mockGraph,
        forgeId: 'forge-partial',
      } as typeof mockResult;
    }

    it('asks the extension to run the clone again against what this run wrote', () => {
      // The button used to show the execution screen and send nothing: the
      // screen waited on a run that was never started.
      failedRun();
      render(<ForgeResults />);

      fireEvent.click(screen.getByTestId('forge-retry-failed'));

      const [request] = sent<Record<string, unknown>>('forge:execute');
      expect(request).toMatchObject({ config: RUN_CONFIG, retryOf: 'forge-partial' });
      expect(request.anonymizationRules).toEqual(RUN_RULES);
      expect(request).not.toHaveProperty('files');
      // A new run, from the statuses up: every node back to idle.
      const graph = request.graph as ForgeGraph;
      expect(graph.nodes.map((n) => n.status)).toEqual(['idle', 'idle', 'idle', 'idle']);
      expect(mockResetNodeStatuses).toHaveBeenCalledTimes(1);
      const envelope = mockPostMessage.mock.calls[0][0] as { payload: BaseMessage };
      expect(mockSetExecutionRequestId).toHaveBeenCalledWith(envelope.payload.id);
      expect(mockSetPhase).toHaveBeenCalledWith('execution');
      expect(mockSetGraph).not.toHaveBeenCalled();
    });

    it('copies the files of what it writes when the run it retries did', () => {
      failedRun();
      mockFileCopy = { enabled: true, maxFileSizeMB: 4, acceptedAsIs: true };
      render(<ForgeResults />);

      fireEvent.click(screen.getByTestId('forge-retry-failed'));

      expect(sent<Record<string, unknown>>('forge:execute')[0].files).toEqual({
        maxFileSizeMB: 4,
        acceptedAsIs: true,
      });
    });

    it('says what the retry writes, and what it does not write twice', () => {
      failedRun();
      render(<ForgeResults />);

      const hint = screen.getByTestId('forge-retry-failed-hint');
      expect(hint.textContent).toBe(
        'Retry Failed runs the clone again: what this run could not write is written, linked to what it did write, which is not written a second time.',
      );
      expect(screen.getByTestId('forge-retry-failed').getAttribute('aria-describedby')).toBe(
        hint.id,
      );
    });

    it('is offered for an object the run added beyond the graph and could not read', () => {
      mockResult = {
        ...makeMockResult(),
        forgeId: 'forge-unread',
        readByObject: [{ objectApiName: 'Account', read: 10 }],
        failedReads: ['PricebookEntry'],
      } as typeof mockResult;
      render(<ForgeResults />);
      expect(screen.getByTestId('forge-retry-failed')).toBeTruthy();
    });

    describe('of a run that stopped before its end', () => {
      // No object of it shows failed: those it never reached are not, and the
      // retry was offered only for a failed one.
      it('writes the rest of a run an error stopped, against what it wrote', () => {
        mockResult = Object.assign(makeMockResult(), { forgeId: 'forge-stopped' });
        mockRunError = { message: 'INVALID_SESSION_ID', stoppedRun: { forgeId: 'forge-stopped' } };
        render(<ForgeResults />);

        const button = screen.getByTestId('forge-retry-failed');
        expect(button.textContent).toBe('Write the rest');
        expect(screen.getByTestId('forge-retry-failed-hint').textContent).toBe(
          'Write the rest runs the clone again: what this run did not write before it stopped is written, linked to what it did write, which is not written a second time.',
        );
        fireEvent.click(button);
        expect(sent<Record<string, unknown>>('forge:execute')[0]).toMatchObject({
          retryOf: 'forge-stopped',
        });
      });

      it('writes the rest of a run a cancel stopped', () => {
        mockResult = Object.assign(makeMockResult(), {
          forgeId: 'forge-cancelled',
          cancelled: true,
        });
        render(<ForgeResults />);
        expect(screen.getByTestId('forge-retry-failed').textContent).toBe('Write the rest');
      });
    });
  });

  /* ---- Duration + Timestamp ---- */

  it('should display duration and timestamp from result', () => {
    render(<ForgeResults />);
    const duration = screen.getByTestId('forge-results-duration');
    expect(duration).toBeDefined();
    // duration = 10000ms => 10s => formatElapsed(10) = "0:10"
    expect(duration.textContent).toContain('0:10');
    const timestamp = screen.getByTestId('forge-results-timestamp');
    expect(timestamp).toBeDefined();
    expect(timestamp.textContent).toContain('2026');
    expect(timestamp.textContent).toMatch(/^Completed: /);
  });

  it('dates a run that stopped before its end by when it stopped, not as completed', () => {
    mockResult = Object.assign(makeMockResult(), { forgeId: 'forge-stopped' });
    mockRunError = { message: 'INVALID_SESSION_ID', stoppedRun: { forgeId: 'forge-stopped' } };
    const { unmount } = render(<ForgeResults />);
    expect(screen.getByTestId('forge-results-timestamp').textContent).toMatch(/^Stopped: /);
    unmount();

    // A cancelled run, as the history keeps it.
    mockRunError = null;
    mockResult = Object.assign(makeMockResult(), { cancelled: true });
    render(<ForgeResults />);
    expect(screen.getByTestId('forge-results-timestamp').textContent).toMatch(/^Stopped: /);
  });

  it('says when the run ended is unknown when its stored time is not a date', () => {
    // It read "Invalid Date".
    mockResult = { ...makeMockResult(), timestamp: 'not a date' };
    render(<ForgeResults />);

    const timestamp = screen.getByTestId('forge-results-timestamp');
    expect(timestamp.textContent).toContain('unknown');
    expect(timestamp.textContent).not.toContain('Invalid Date');
  });

  /* ---- Sort by column ---- */

  it('should sort table rows when clicking a column header', () => {
    render(<ForgeResults />);
    // Default sort is objectApiName asc: Account, Case, Contact
    const rows = screen.getAllByTestId('forge-results-row');
    expect(rows[0].textContent).toContain('Account');
    expect(rows[1].textContent).toContain('Case');
    expect(rows[2].textContent).toContain('Contact');

    // Click objectApiName header again to toggle to desc
    fireEvent.click(screen.getByTestId('forge-results-sort-object'));
    const rowsDesc = screen.getAllByTestId('forge-results-row');
    expect(rowsDesc[0].textContent).toContain('Contact');
    expect(rowsDesc[1].textContent).toContain('Case');
    expect(rowsDesc[2].textContent).toContain('Account');
  });

  /* ---- Filter by status ---- */

  it('names the status filter', () => {
    render(<ForgeResults />);
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toBe(
      screen.getByTestId('forge-results-status-filter'),
    );
  });

  it('should filter table rows by status', () => {
    render(<ForgeResults />);
    const filter = screen.getByTestId('forge-results-status-filter');
    expect(filter).toBeDefined();

    // Filter to "done" only
    fireEvent.change(filter, { target: { value: 'done' } });
    const rows = screen.getAllByTestId('forge-results-row');
    // Account (done) + Contact (done) = 2 rows, Case (skipped) filtered out
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Account');
    expect(rows[1].textContent).toContain('Contact');
  });

  it('lists an object a cancel stopped while it was written as stopped, and filters it so', () => {
    // It ended done, and the results listed it among the objects written whole.
    mockGraph = {
      ...makeMockGraph(),
      nodes: makeMockGraph().nodes.map((node) =>
        node.objectApiName === 'Contact' ? { ...node, status: 'stopped' as const } : node,
      ),
    };
    render(<ForgeResults />);

    const badge = screen.getByTestId('forge-results-status-stopped');
    expect(badge.textContent).toBe('Stopped');
    expect(badge.className).toContain('text-status-warning');
    expect(screen.queryAllByTestId('forge-results-status-done')).toHaveLength(1);

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), {
      target: { value: 'stopped' },
    });
    expect(screen.getByRole('option', { name: 'Stopped' })).toBeDefined();
    expect(
      screen.getAllByTestId('forge-results-row').map((row) => row.querySelector('td')?.textContent),
    ).toEqual(['Contact']);
  });

  /** Each object's status as its badge says it, in the table's order. */
  const statusBadges = (): Array<string | null> =>
    screen
      .getAllByTestId('forge-results-row')
      .map(
        (row) => row.querySelector('[data-testid^="forge-results-status-"]')?.textContent ?? null,
      );

  it('names the status of each object in words, not by its code', () => {
    // The badge printed the code itself — "done", "error" — in every language.
    const graph = makeMockGraphWithError();
    mockGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.objectApiName === 'Contact' ? { ...node, status: 'stopped' as const } : node,
      ),
    };
    render(<ForgeResults />);

    // Account, Case, Contact, Opportunity: sorted by name.
    expect(statusBadges()).toEqual(['Done', 'Skipped', 'Stopped', 'Failed']);
  });

  it('names each status in the language the panel is set to, and keeps the codes in the report it copies', async () => {
    // The report is written in English, headings and notes alike: the codes
    // the run gave stay in it, as the tests and scripts that read it expect.
    mockGraph = makeMockGraphWithError();
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      render(<ForgeResults />);

      expect(statusBadges()).toEqual([
        fr.forge.nodeStatus.done,
        fr.forge.nodeStatus.skipped,
        fr.forge.nodeStatus.done,
        fr.forge.nodeStatus.error,
      ]);
      await act(async () => {
        fireEvent.click(screen.getByTestId('forge-copy-report'));
      });
      const report = writeText.mock.calls[0]?.[0] ?? '';
      expect(report).toContain('| Account | 10 | done | - |');
      expect(report).toContain('| Opportunity | 8 | error | UNABLE_TO_LOCK_ROW |');
    } finally {
      await i18n.changeLanguage('en');
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  /* ---- Collapsible logs toggle ---- */

  it('should toggle execution logs visibility', () => {
    render(<ForgeResults />);
    const toggleBtn = screen.getByTestId('forge-results-toggle-logs');
    expect(toggleBtn).toBeDefined();
    // Logs should be collapsed by default (no logstream visible)
    expect(screen.queryByTestId('logstream')).toBeNull();
    // Click to expand
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('logstream')).toBeDefined();
    // Click again to collapse
    fireEvent.click(toggleBtn);
    expect(screen.queryByTestId('logstream')).toBeNull();
  });

  /* ---- Id remap table virtualization ---- */

  /** One source -> target pair per cloned record, as the executor returns them. */
  const makeIdRemapTable = (count: number): Record<string, string> => {
    const table: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      const suffix = String(i).padStart(9, '0');
      table[`001SRC${suffix}`] = `001TGT${suffix}`;
    }
    return table;
  };

  it('should render a window, not 5000 rows, for a large id remap table', () => {
    mockResult = { ...makeMockResult(), idRemapTable: makeIdRemapTable(5000) };
    render(<ForgeResults />);

    const rows = screen.getAllByTestId('forge-id-mapping-row');
    expect(rows.length).toBeGreaterThan(0);
    // A plain table would mount all 5000 rows (10 000 cells) at once.
    expect(rows.length).toBeLessThan(100);
    expect(screen.getByTestId('forge-id-mapping-virtual')).toBeDefined();
  });

  it('should still announce the full count while rendering only a window', () => {
    mockResult = { ...makeMockResult(), idRemapTable: makeIdRemapTable(5000) };
    render(<ForgeResults />);

    const panel = screen.getByTestId('forge-id-mapping');
    expect(panel.textContent).toContain('5000');
    expect(screen.getAllByTestId('forge-id-mapping-row').length).toBeLessThan(100);
  });

  it('should keep the plain table below the virtualization threshold', () => {
    const count = ID_REMAP_VIRTUALIZE_THRESHOLD;
    mockResult = { ...makeMockResult(), idRemapTable: makeIdRemapTable(count) };
    render(<ForgeResults />);

    expect(screen.getByTestId('forge-id-mapping-table')).toBeDefined();
    expect(screen.queryByTestId('forge-id-mapping-virtual')).toBeNull();
    expect(screen.getAllByTestId('forge-id-mapping-row')).toHaveLength(count);
  });

  /* ---- Records the target already held ---- */

  it('reads the inserted count the run reported rather than the graph it never updates', () => {
    mockResult = { ...makeMockResult(), createdCount: 12 } as typeof mockResult;
    render(<ForgeResults />);

    expect(screen.getAllByTestId('kpi-value')[0].textContent).toBe('12');
  });

  it('shows the records linked to existing ones next to the inserted ones, not inside them', () => {
    mockResult = {
      ...makeMockResult(),
      createdCount: 12,
      linkedExistingCount: 3,
    } as typeof mockResult;
    render(<ForgeResults />);

    const cards = screen.getAllByTestId('kpi-card');
    expect(cards).toHaveLength(7);
    const values = screen.getAllByTestId('kpi-value').map((v) => v.textContent);
    expect(values[0]).toBe('12');
    expect(values[1]).toBe('3');
    expect(cards[1].textContent).toContain('Linked to existing');
    // (12 created + 3 linked) of 35
    expect(values[4]).toBe('43%');
  });

  it('lists per object what was linked and what could not be identified', () => {
    mockResult = {
      ...makeMockResult(),
      linkedExistingCount: 2,
      existingRecords: [
        { objectApiName: 'Account', linked: 2, unidentified: 0 },
        { objectApiName: 'AccountContactRelation', linked: 0, unidentified: 1 },
      ],
    } as typeof mockResult;
    render(<ForgeResults />);

    const rows = screen.getAllByTestId('forge-results-existing-row').map((r) => r.textContent);
    expect(rows).toEqual([
      'Account — 2 linked, not created',
      'AccountContactRelation — 1 not identified — counted as failed, and its children lost the link',
    ]);
  });

  it('shows no notice and no extra card for a run the target held nothing of', () => {
    render(<ForgeResults />);

    expect(screen.queryByTestId('forge-results-existing')).toBeNull();
    expect(screen.getAllByTestId('kpi-card')).toHaveLength(6);
  });

  describe('the calls the run made', () => {
    /** What the card of the calls, the last of the row, says: its label, then its value. */
    function callsCard(): { label: string; value: string } {
      const card = screen.getAllByTestId('kpi-card').at(-1);
      if (!card) throw new Error('no KPI card');
      const value = within(card).getByTestId('kpi-value').textContent ?? '';
      const text = card.textContent ?? '';
      return { label: text.endsWith(value) ? text.slice(0, -value.length) : text, value };
    }

    /** The graph shown, discovery's estimate of 3 and 2 calls on its two objects taken. */
    function withEstimates(): void {
      mockGraph = {
        ...mockGraph,
        nodes: mockGraph.nodes.map((node) =>
          node.objectApiName === 'Account'
            ? { ...node, estimatedApiCalls: 3 }
            : node.objectApiName === 'Contact'
              ? { ...node, estimatedApiCalls: 2 }
              : node,
        ),
      };
    }

    it('shows the calls the run counted, not discovery estimates added up', () => {
      // The card added up the estimate of each node, a guess at the writes of
      // whole tables, and called it the calls the run consumed.
      withEstimates();
      mockResult = { ...makeMockResult(), apiCalls: 64 } as typeof mockResult;
      render(<ForgeResults />);

      expect(callsCard()).toEqual({ label: 'API Calls', value: '64' });
    });

    it('shows the estimate discovery made, said to be one, for a result that counted no call', () => {
      withEstimates();
      render(<ForgeResults />);

      expect(callsCard()).toEqual({ label: 'Estimated API Calls', value: '5' });
    });

    it('gives no estimate for a run whose objects nobody counted, rather than zero', () => {
      // A starter template's graph skips discovery: every estimate is a
      // placeholder zero, of a run that reads and writes each object.
      mockGraph = {
        ...mockGraph,
        nodes: mockGraph.nodes.map((node) => ({ ...node, recordCountUnknown: true })),
      };
      render(<ForgeResults />);

      expect(callsCard()).toEqual({ label: 'Estimated API Calls', value: '—' });
    });
  });

  it('marks the Id-map rows that point at a record the target already held', () => {
    mockResult = {
      ...makeMockResult(),
      idRemapTable: {
        '001SRC000000001': '001TGT000000001',
        '001SRC000000002': '001TGT000000002',
      },
      idRemapExisting: ['001SRC000000002'],
    } as typeof mockResult;
    render(<ForgeResults />);

    const rows = screen.getAllByTestId('forge-id-mapping-row');
    expect(rows[0].querySelector('[data-testid="forge-id-mapping-existing"]')).toBeNull();
    expect(rows[1].querySelector('[data-testid="forge-id-mapping-existing"]')?.textContent).toBe(
      'existing',
    );
    expect(screen.getByTestId('forge-id-mapping').textContent).toContain(
      '1 of them was already in the target org: linked, not created.',
    );
  });

  it('warns about an object whose source read was cut short', () => {
    // Everything past the 50 000-record / 500-page bound was never read, and
    // the run reports success either way.
    mockResult = { ...makeMockResult(), truncatedObjects: ['Contact'] };
    render(<ForgeResults />);

    expect(screen.getByTestId('forge-results-truncated').textContent).toContain('Contact');
  });

  it('shows no truncation warning for a run that read everything', () => {
    mockResult = { ...makeMockResult(), truncatedObjects: [] };
    render(<ForgeResults />);

    expect(screen.queryByTestId('forge-results-truncated')).toBeNull();
  });

  it("names, per object, the fields the clone left empty because they hold a file's content", () => {
    mockResult = Object.assign(makeMockResult(), {
      fileContentFieldsLeftOut: [
        { objectApiName: 'Account', fields: ['Logo__c'] },
        { objectApiName: 'QuoteDocument', fields: ['Document'] },
      ],
    });
    render(<ForgeResults />);

    expect(screen.getByTestId('forge-results-file-content').textContent).toContain(
      "these fields hold a file's content",
    );
    expect(
      screen.getAllByTestId('forge-results-file-content-row').map((row) => row.textContent),
    ).toEqual(['Account — Logo__c', 'QuoteDocument — Document']);
  });

  it('says nothing of file content for a run that left no field empty', () => {
    mockResult = makeMockResult();
    render(<ForgeResults />);

    expect(screen.queryByTestId('forge-results-file-content')).toBeNull();
  });

  it('opens one report at a time when an object has two at the same stage', () => {
    // The orders the target refused and the orders left drafts are two
    // reports on one object at one stage. Keyed by the object and the stage,
    // the two rows shared React's key and their open state: opening one
    // opened both.
    mockResult = Object.assign(makeMockResult(), {
      errors: [
        {
          objectApiName: 'Order',
          stage: 'insert' as const,
          failedCount: 1,
          attemptedCount: 2,
          samples: [
            { recordSummary: 'Name=Second', messages: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'] },
          ],
        },
        {
          objectApiName: 'Order',
          stage: 'insert' as const,
          failedCount: 1,
          attemptedCount: 1,
          samples: [{ recordSummary: 'Order 801 Status=Activated', messages: ['Left a draft'] }],
        },
      ],
    });
    render(<ForgeResults />);

    const [refused, drafts] = screen
      .getAllByTestId('forge-errors-row')
      .map((row) => within(row).getByRole('button'));
    fireEvent.click(refused);

    expect(refused.getAttribute('aria-expanded')).toBe('true');
    expect(drafts.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByTestId('forge-errors-samples')).toHaveLength(1);
  });
});
