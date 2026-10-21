import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import en from '../../../i18n/locales/en.json';
import type { CsvImportState } from './useCsvImport';

/*
 * The CSV import once it is asked to run: what the execute step offers, the
 * way out it hides while the import writes, and how a stopped import reads.
 * The hook stands in, so the step is drawn as each state leaves it.
 */

/** The state the wizard reads, set by each test. */
let csvState: Partial<CsvImportState>;

vi.mock('./useCsvImport', () => ({
  useCsvImport: () => csvState,
}));

/** What `useBridgeQuery` answers, per type asked, and what it was asked. */
let queried: Record<string, unknown> = {};
const asked: Array<{ type: string; payload: unknown }> = [];
vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload: unknown) => {
    asked.push({ type, payload });
    return { data: queried[type] ?? null, loading: false, error: null, refetch: vi.fn() };
  },
}));

/** `execution:abort`, which Stop sends. */
const mockAbortMutate = vi.fn();
vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: mockAbortMutate,
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

import { CsvUploadWizard } from './CsvUploadWizard';

/** The execute step, with three rows parsed, in `executionStatus`. */
function executeStep(over: Partial<CsvImportState>): Partial<CsvImportState> {
  return {
    step: 'execute',
    executionStatus: 'idle',
    parsedRows: [{ Name: 'a' }, { Name: 'b' }, { Name: 'c' }],
    executionResult: null,
    runRequestId: null,
    handleExecute: vi.fn(),
    setStep: vi.fn(),
    ...over,
  };
}

describe('CsvUploadWizard, once the import is asked to run', () => {
  beforeEach(() => {
    mockAbortMutate.mockClear();
    queried = {};
    asked.length = 0;
  });

  it('no longer says before Execute that SandForge cannot take back what the import writes', () => {
    csvState = executeStep({});
    render(<CsvUploadWizard onBack={vi.fn()} />);

    expect(screen.queryByTestId('csv-no-way-back')).toBeNull();
    expect(screen.queryByText(en.common.noWayBack)).toBeNull();
    expect(screen.getByTestId('execute-button').getAttribute('aria-describedby')).toBeNull();
  });

  it('offers on its results the removal of what the import created, by the id it is kept under', () => {
    queried = {
      'seed:removal:info': {
        info: {
          runId: 'req-csv-7',
          origin: 'csv',
          targetOrgId: 'org-1',
          startedAt: '2026-10-21T10:00:00.000Z',
          endedAt: '2026-10-21T10:01:00.000Z',
          created: 2,
          left: [{ objectApiName: 'Account', count: 2 }],
        },
      },
    };
    csvState = executeStep({
      executionStatus: 'complete',
      executionResult: { insertedCount: 2, failedCount: 0, errors: [], runId: 'req-csv-7' },
    });
    render(<CsvUploadWizard onBack={vi.fn()} />);

    expect(asked).toContainEqual({ type: 'seed:removal:info', payload: { runId: 'req-csv-7' } });
    expect(screen.getByTestId('seed-removal-created').textContent).toBe(
      '2 records created in org-1',
    );
    expect(screen.getByTestId('seed-removal-remove')).toBeDefined();
  });

  it('offers no removal of an import that created nothing', () => {
    csvState = executeStep({
      executionStatus: 'complete',
      executionResult: { insertedCount: 0, failedCount: 1, errors: ['REQUIRED_FIELD_MISSING'] },
    });
    render(<CsvUploadWizard onBack={vi.fn()} />);

    expect(asked.some((query) => query.type === 'seed:removal:info')).toBe(false);
    expect(screen.queryByTestId('seed-removal')).toBeNull();
  });

  it('stops a running import by the id of its request, and hides the Cancel that only left the wizard', () => {
    // The Cancel went back to the gallery and sent nothing: every row was
    // still written, and the import's answer was lost with the wizard.
    const onRunningChange = vi.fn();
    csvState = executeStep({ executionStatus: 'executing', runRequestId: 'req-csv-7' });
    render(<CsvUploadWizard onBack={vi.fn()} onRunningChange={onRunningChange} />);

    expect(screen.queryByTestId('csv-cancel-button')).toBeNull();
    expect(onRunningChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId('csv-stop'));

    expect(mockAbortMutate).toHaveBeenCalledWith({ operationId: 'req-csv-7' });
    expect(screen.getByTestId('csv-stopping').textContent).toBe(en.common.runStopping);
    expect(screen.getByTestId('csv-stop').getAttribute('aria-disabled')).toBe('true');
  });

  it('reads a stopped import as cancelled, with the rows it left in the org, not as a success', () => {
    const onRunningChange = vi.fn();
    csvState = executeStep({
      executionStatus: 'complete',
      executionResult: { insertedCount: 2, failedCount: 0, errors: [], cancelled: true },
    });
    render(<CsvUploadWizard onBack={vi.fn()} onRunningChange={onRunningChange} />);

    expect(screen.getByTestId('csv-cancelled').textContent).toBe(
      'Cancelled: 2 records imported before the stop stay in the org',
    );
    expect(screen.queryByText('2 records inserted')).toBeNull();
    expect(screen.getByTestId('csv-cancel-button')).toBeDefined();
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
  });

  it('still reads an import that ran to its end as inserted', () => {
    csvState = executeStep({
      executionStatus: 'complete',
      executionResult: { insertedCount: 3, failedCount: 0, errors: [] },
    });
    render(<CsvUploadWizard onBack={vi.fn()} />);

    expect(screen.getByText('3 records inserted')).toBeDefined();
    expect(screen.queryByTestId('csv-cancelled')).toBeNull();
  });
});
