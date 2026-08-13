import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../../i18n';
import { CloneResultsPanel } from './CloneResultsPanel';
import type { CloneExecutionResult } from '@sandforge/shared';

const mockSuccessResult: CloneExecutionResult = {
  status: 'success',
  totalSourceRecords: 200,
  totalInserted: 200,
  totalFailed: 0,
  durationMs: 12500,
  objectResults: [
    {
      objectApiName: 'Account',
      sourceCount: 50,
      insertedCount: 50,
      failedCount: 0,
      idMappings: [
        { sourceId: '001xx001', targetId: '001yy001' },
        { sourceId: '001xx002', targetId: '001yy002' },
      ],
      errors: [],
    },
    {
      objectApiName: 'Contact',
      sourceCount: 150,
      insertedCount: 150,
      failedCount: 0,
      idMappings: [{ sourceId: '003xx001', targetId: '003yy001' }],
      errors: [],
    },
  ],
};

const mockPartialResult: CloneExecutionResult = {
  status: 'partial',
  totalSourceRecords: 100,
  totalInserted: 80,
  totalFailed: 20,
  durationMs: 8000,
  objectResults: [
    {
      objectApiName: 'Account',
      sourceCount: 50,
      insertedCount: 50,
      failedCount: 0,
      idMappings: [{ sourceId: '001xx001', targetId: '001yy001' }],
      errors: [],
    },
    {
      objectApiName: 'Contact',
      sourceCount: 50,
      insertedCount: 30,
      failedCount: 20,
      idMappings: [{ sourceId: '003xx001', targetId: '003yy001' }],
      errors: [
        { sourceId: '003xx002', message: 'REQUIRED_FIELD_MISSING: LastName' },
        { sourceId: '003xx003', message: 'DUPLICATE_VALUE: Email' },
      ],
    },
  ],
};

/** 30 failures on a single object, no mappings, so only the errors table renders. */
const mockManyErrorsResult: CloneExecutionResult = {
  status: 'failure',
  totalSourceRecords: 30,
  totalInserted: 0,
  totalFailed: 30,
  durationMs: 3000,
  objectResults: [
    {
      objectApiName: 'Contact',
      sourceCount: 30,
      insertedCount: 0,
      failedCount: 30,
      idMappings: [],
      errors: Array.from({ length: 30 }, (_, i) => ({
        sourceId: `003xx${String(i).padStart(3, '0')}`,
        message: `REQUIRED_FIELD_MISSING: LastName #${i}`,
      })),
    },
  ],
};

/** Both tables overflow a page, so each needs its own pagination state. */
const mockBothOverflowResult: CloneExecutionResult = {
  status: 'partial',
  totalSourceRecords: 60,
  totalInserted: 30,
  totalFailed: 30,
  durationMs: 4000,
  objectResults: [
    {
      objectApiName: 'Contact',
      sourceCount: 60,
      insertedCount: 30,
      failedCount: 30,
      idMappings: Array.from({ length: 30 }, (_, i) => ({
        sourceId: `003src${String(i).padStart(3, '0')}`,
        targetId: `003tgt${String(i).padStart(3, '0')}`,
      })),
      errors: Array.from({ length: 30 }, (_, i) => ({
        sourceId: `003err${String(i).padStart(3, '0')}`,
        message: `DUPLICATE_VALUE: Email #${i}`,
      })),
    },
  ],
};

describe('CloneResultsPanel', () => {
  it('should render success status with counts', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    expect(screen.getByTestId('clone-results-panel')).toBeDefined();
    expect(screen.getByTestId('clone-results-summary')).toBeDefined();

    const summary = screen.getByTestId('clone-results-summary');
    expect(summary.textContent).toContain('success');

    const counts = screen.getByTestId('clone-results-counts');
    expect(counts.textContent).toContain('200');
  });

  it('should show duration', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    const summary = screen.getByTestId('clone-results-summary');
    expect(summary.textContent).toContain('12.5');
  });

  it('should show per-object results in accordion', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    const panel = screen.getByTestId('clone-results-panel');
    expect(panel.textContent).toContain('Account');
    expect(panel.textContent).toContain('Contact');
  });

  it('should show failed count for partial results', () => {
    render(<CloneResultsPanel result={mockPartialResult} onDone={vi.fn()} />);

    const summary = screen.getByTestId('clone-results-summary');
    expect(summary.textContent).toContain('partial');

    const counts = screen.getByTestId('clone-results-counts');
    expect(counts.textContent).toContain('80');
  });

  it('should call onDone when clicking Done button', () => {
    const onDone = vi.fn();
    render(<CloneResultsPanel result={mockSuccessResult} onDone={onDone} />);

    fireEvent.click(screen.getByTestId('clone-results-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('should have export mapping button', () => {
    render(<CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />);

    expect(screen.getByTestId('clone-export-mapping')).toBeDefined();
  });

  it('should render errors for failed objects in partial results', () => {
    render(<CloneResultsPanel result={mockPartialResult} onDone={vi.fn()} />);

    const panel = screen.getByTestId('clone-results-panel');
    // The accordion content contains error info for Contact
    expect(panel.textContent).toContain('Contact');
  });

  it('should paginate the errors table instead of rendering every failure', () => {
    render(<CloneResultsPanel result={mockManyErrorsResult} onDone={vi.fn()} />);

    expect(screen.getAllByTestId(/^table-row-/)).toHaveLength(25);
    expect(screen.getByTestId('pagination-summary').textContent).toContain('30');
    expect(screen.getByText('REQUIRED_FIELD_MISSING: LastName #24')).toBeDefined();
    expect(screen.queryByText('REQUIRED_FIELD_MISSING: LastName #25')).toBeNull();
  });

  it('should show the remaining errors on the next page', () => {
    render(<CloneResultsPanel result={mockManyErrorsResult} onDone={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(screen.getAllByTestId(/^table-row-/)).toHaveLength(5);
    expect(screen.getByText('REQUIRED_FIELD_MISSING: LastName #25')).toBeDefined();
    expect(screen.queryByText('REQUIRED_FIELD_MISSING: LastName #24')).toBeNull();
  });

  it('should page the errors table without moving the mappings table', () => {
    render(<CloneResultsPanel result={mockBothOverflowResult} onDone={vi.fn()} />);

    const [mappingsTable, errorsTable] = screen.getAllByTestId('data-table');
    const errorsNext = screen.getAllByRole('button', { name: 'Next page' })[1];
    fireEvent.click(errorsNext);

    expect(within(errorsTable).getByText('DUPLICATE_VALUE: Email #25')).toBeDefined();
    expect(within(mappingsTable).getAllByTestId(/^table-row-/)).toHaveLength(25);
    expect(within(mappingsTable).getByText('003src000')).toBeDefined();
  });
});
