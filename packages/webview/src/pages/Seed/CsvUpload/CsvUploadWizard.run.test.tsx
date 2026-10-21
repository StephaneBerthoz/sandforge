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

vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
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
  });

  it('says before Execute that SandForge cannot take back what the import writes', () => {
    csvState = executeStep({});
    render(<CsvUploadWizard onBack={vi.fn()} />);

    expect(screen.getByTestId('csv-no-way-back').textContent).toBe(en.common.noWayBack);
    expect(screen.getByTestId('execute-button').getAttribute('aria-describedby')).toBe(
      'csv-no-way-back',
    );
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
