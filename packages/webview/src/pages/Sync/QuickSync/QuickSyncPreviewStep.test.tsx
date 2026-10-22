import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';
import '../../../i18n';
import type { BaseMessage, QuickSyncPreview, SyncExecutionResult } from '@sandforge/shared';

const mockPostMessage = vi.fn();

/** Stable identity so useSendMessage's useCallback does not re-fire. */
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { QuickSyncPreviewStep } from './QuickSyncPreviewStep';

/** Every message of `type` the step sent through the bridge. */
function sentAll(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

/** Answer the last `requestType` the step sent, correlated to it as the extension does. */
function answer(requestType: string, type: string, payload: unknown): void {
  const request = sentAll(requestType).pop();
  if (!request) throw new Error(`no '${requestType}' was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${type}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

const mockPreview: QuickSyncPreview = {
  objects: [
    { objectApiName: 'Account', recordCount: 500, estimatedApiCalls: 3, isParentDependency: false },
    { objectApiName: 'Contact', recordCount: 1200, estimatedApiCalls: 7, isParentDependency: true },
  ],
  totalRecords: 1700,
  totalApiCalls: 10,
  estimatedDurationSec: 15,
};

const mockResult: SyncExecutionResult = {
  configId: 'cfg-1',
  operationId: 'op-1',
  status: 'success',
  objectResults: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      processed: 500,
      success: 500,
      failed: 0,
      skipped: 0,
      conflictCount: 0,
      errors: [],
    },
    {
      objectApiName: 'Contact',
      operation: 'upsert',
      processed: 1200,
      success: 1195,
      failed: 5,
      skipped: 0,
      conflictCount: 0,
      errors: ['Some error'],
    },
  ],
  totalProcessed: 1700,
  totalSuccess: 1695,
  totalFailed: 5,
  totalSkipped: 0,
  duration: 14500,
  timestamp: '2024-01-01T00:00:00Z',
};

describe('QuickSyncPreviewStep', () => {
  const defaultProps = {
    preview: mockPreview,
    result: null as SyncExecutionResult | null,
    isExecuting: false,
    onExecute: vi.fn(),
    onReset: vi.fn(),
    onBack: vi.fn(),
  };

  it('asks what the last run between the two orgs left of the objects before it inserts them again', () => {
    mockPostMessage.mockClear();
    render(
      <QuickSyncPreviewStep
        preview={mockPreview}
        result={null}
        isExecuting={false}
        onExecute={vi.fn()}
        onReset={vi.fn()}
        onBack={vi.fn()}
        sourceOrgId="org-src"
        targetOrgId="org-tgt"
      />,
    );

    const asked = mockPostMessage.mock.calls
      .map((call) => (call[0] as { payload: { type: string; payload: unknown } }).payload)
      .filter((message) => message.type === 'sync:earlier-copies');
    expect(asked.map((message) => message.payload)).toEqual([
      { sourceOrgId: 'org-src', targetOrgId: 'org-tgt', objects: ['Account', 'Contact'] },
    ]);
  });

  it('renders preview data with object count and record totals', () => {
    render(<QuickSyncPreviewStep {...defaultProps} />);

    const summary = screen.getByTestId('quick-sync-preview-summary');
    expect(summary).toBeDefined();
    expect(summary.textContent).toContain('1700');
    expect(summary.textContent).toContain('10');
  });

  it('gives each object’s API calls as the estimate they are', () => {
    // A call for each batch of the rows counted, before anything is read:
    // "3 API calls" read as calls counted, under a summary that says its
    // calls are estimated.
    render(<QuickSyncPreviewStep {...defaultProps} />);

    const objects = screen.getByTestId('quick-sync-preview-objects').textContent;
    expect(objects).toContain('3 estimated API calls');
    expect(objects).toContain('7 estimated API calls');
  });

  it('shows Sync Now button when not executing', () => {
    render(<QuickSyncPreviewStep {...defaultProps} />);

    const btn = screen.getByTestId('quick-sync-go-btn');
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain('Sync Now');
  });

  it('shows progress bar during execution', () => {
    render(<QuickSyncPreviewStep {...defaultProps} isExecuting={true} />);

    expect(screen.getByTestId('quick-sync-executing')).toBeDefined();
    expect(screen.getByRole('progressbar')).toBeDefined();
  });

  it('offers pause and cancel once the run is sent, on the page that started it', () => {
    const { rerender } = render(<QuickSyncPreviewStep {...defaultProps} isExecuting={true} />);
    // While the run is prepared it has no id yet, so nothing can name it.
    expect(screen.queryByTestId('sync-run-controls')).toBeNull();

    rerender(
      <QuickSyncPreviewStep {...defaultProps} isExecuting={true} runOperationId="wv-quick-1" />,
    );

    expect(screen.getByTestId('sync-pause')).toBeDefined();
    expect(screen.getByTestId('sync-cancel').textContent).toBe('Cancel run');
  });

  it('shows results after execution completes', () => {
    render(<QuickSyncPreviewStep {...defaultProps} result={mockResult} />);

    expect(screen.getByTestId('quick-sync-results')).toBeDefined();
    expect(screen.getByTestId('quick-sync-result-summary')).toBeDefined();
    expect(screen.getByTestId('quick-sync-new-btn')).toBeDefined();
  });

  it('says the standard price book matched beside the price books, with no refusal listed', () => {
    const pricebooks = {
      objectApiName: 'Pricebook2',
      operation: 'insert' as const,
      processed: 1,
      success: 1,
      failed: 0,
      skipped: 0,
      conflictCount: 0,
      errors: [],
      standardPricebookMatched: true as const,
    };
    render(
      <QuickSyncPreviewStep
        {...defaultProps}
        result={{ ...mockResult, objectResults: [pricebooks] }}
      />,
    );

    const line = screen.getByTestId('quick-sync-result-pricebook-Pricebook2');
    expect(line.textContent).toBe(
      "Standard price book: matched to the target org's, never written.",
    );
    expect(screen.queryByTestId('quick-sync-result-errors-Pricebook2')).toBeNull();
  });

  it('says the rows written in another currency and the prices it settled, as the Sync tab does, with no refusal listed', () => {
    // Quick Sync runs the same sync as the Sync tab, whose results and history
    // say both; its own results said neither.
    const entries = {
      objectApiName: 'PricebookEntry',
      operation: 'insert' as const,
      processed: 2,
      success: 2,
      failed: 0,
      skipped: 0,
      conflictCount: 0,
      errors: [],
      currenciesReplaced: [
        {
          objectApiName: 'PricebookEntry',
          from: 'GBP',
          to: 'USD',
          chosenBy: 'corporate' as const,
          rows: 1,
          fields: ['UnitPrice'],
        },
      ],
      pricesSettled: [
        { from: 'GBP', to: 'USD', how: 'replaced' as const, forLines: false, prices: 2 },
        { from: 'GBP', to: 'EUR', how: 'converted' as const, forLines: true, prices: 1 },
      ],
    };
    render(
      <QuickSyncPreviewStep
        {...defaultProps}
        result={{ ...mockResult, objectResults: [entries] }}
      />,
    );

    const currencies = screen.getByRole('region', { name: 'Written in another currency' });
    expect(currencies.textContent).toContain('GBP');
    expect(currencies.textContent).toContain('UnitPrice');
    const prices = screen.getByRole('region', { name: 'Prices in another currency' });
    expect(screen.getAllByTestId('results-price-currencies-row')).toHaveLength(2);
    expect(prices.textContent).toContain('EUR');
    expect(screen.queryByTestId('quick-sync-result-errors-PricebookEntry')).toBeNull();
  });

  it('calls a run a cancel stopped cancelled, not partial', () => {
    render(
      <QuickSyncPreviewStep
        {...defaultProps}
        result={{ ...mockResult, status: 'partial', cancelled: true }}
      />,
    );

    const summary = screen.getByTestId('quick-sync-result-summary');
    expect(summary.textContent).toContain('Cancelled');
    expect(summary.textContent).not.toContain('Partially Complete');
  });

  it('calls onExecute when Sync Now button is clicked', () => {
    const onExecute = vi.fn();
    render(<QuickSyncPreviewStep {...defaultProps} onExecute={onExecute} />);

    fireEvent.click(screen.getByTestId('quick-sync-go-btn'));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('offers to remove what the run created, as the Sync tab does, and says a second run inserts again', async () => {
    // Quick Sync inserts every record: a wrong pick, or a run started twice,
    // was taken back from the History tab alone, which nothing here named.
    mockPostMessage.mockClear();
    const created = {
      ...mockResult,
      created: {
        runId: 'run-quick',
        objects: [{ objectApiName: 'Account', count: 500 }],
        files: 0,
      },
    };
    render(<QuickSyncPreviewStep {...defaultProps} result={created} />);

    // The removal card is a chunk of its own: it asks once it is drawn.
    await waitFor(() =>
      expect(sentAll('sync:removal:info').map((message) => message.payload)).toEqual([
        { runId: 'run-quick' },
      ]),
    );
    answer('sync:removal:info', 'sync:removal:info:response', {
      info: {
        runId: 'run-quick',
        configId: 'cfg-1',
        configName: 'Quick Sync',
        sourceOrgId: 'org-src',
        targetOrgId: 'org-tgt',
        startedAt: '2026-10-21T08:00:00.000Z',
        endedAt: '2026-10-21T08:01:00.000Z',
        created: 500,
        left: [{ objectApiName: 'Account', count: 500 }],
      },
    });
    expect(
      within(screen.getByTestId('quick-sync-result-removal')).getByTestId('sync-removal-remove')
        .textContent,
    ).toBe('Remove what this run created');
    expect(screen.getByTestId('quick-sync-again-inserts').textContent).toContain(
      'a Quick Sync inserts these records a second time',
    );
  });

  it('offers no removal for a run that created nothing', () => {
    mockPostMessage.mockClear();
    render(<QuickSyncPreviewStep {...defaultProps} result={mockResult} />);

    expect(sentAll('sync:removal:info')).toEqual([]);
    expect(screen.queryByTestId('quick-sync-again-inserts')).toBeNull();
  });

  it('opens the run in the history, by its operation id', () => {
    const onOpenHistory = vi.fn();
    render(
      <QuickSyncPreviewStep {...defaultProps} result={mockResult} onOpenHistory={onOpenHistory} />,
    );

    fireEvent.click(screen.getByTestId('quick-sync-open-history'));
    expect(onOpenHistory).toHaveBeenCalledWith('op-1');
  });

  it('says what the run did with emails and phone numbers, and the rows linked or written without a lookup, with no refusal listed', () => {
    const contacts = {
      objectApiName: 'Contact',
      operation: 'insert' as const,
      processed: 3,
      success: 2,
      failed: 0,
      skipped: 1,
      conflictCount: 0,
      errors: [],
      linkedToExisting: { records: 1, refusal: 'DUPLICATES_DETECTED: Use one of these records?' },
      lookupsLeftOut: [{ records: 2, fields: ['OwnerId'], reason: 'notInTarget' as const }],
    };
    render(
      <QuickSyncPreviewStep
        {...defaultProps}
        result={{
          ...mockResult,
          objectResults: [contacts],
          contactPoints: {
            neutralized: true,
            fields: [{ objectApiName: 'Contact', field: 'Email', kind: 'email', values: 2 }],
            values: 2,
          },
        }}
      />,
    );

    expect(screen.getByTestId('forge-results-contact-points-summary').textContent).toContain(
      'Neutralized before writing: 2 values in 1 field.',
    );
    const written = screen.getByTestId('quick-sync-result-written-Contact');
    expect(written.textContent).toContain(
      '1 record linked to a record the target org already holds, not written',
    );
    expect(written.textContent).toContain(
      '2 records written without OwnerId: they named records the target org does not have.',
    );
    // Listed among the refusals, each read "1 × …" in red.
    expect(screen.queryByTestId('quick-sync-result-errors-Contact')).toBeNull();
  });

  it('calls onReset when New Quick Sync button is clicked', () => {
    const onReset = vi.fn();
    render(<QuickSyncPreviewStep {...defaultProps} result={mockResult} onReset={onReset} />);

    fireEvent.click(screen.getByTestId('quick-sync-new-btn'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
