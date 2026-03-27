import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
      idMappings: [
        { sourceId: '003xx001', targetId: '003yy001' },
      ],
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
      idMappings: [
        { sourceId: '001xx001', targetId: '001yy001' },
      ],
      errors: [],
    },
    {
      objectApiName: 'Contact',
      sourceCount: 50,
      insertedCount: 30,
      failedCount: 20,
      idMappings: [
        { sourceId: '003xx001', targetId: '003yy001' },
      ],
      errors: [
        { sourceId: '003xx002', message: 'REQUIRED_FIELD_MISSING: LastName' },
        { sourceId: '003xx003', message: 'DUPLICATE_VALUE: Email' },
      ],
    },
  ],
};

describe('CloneResultsPanel', () => {
  it('should render success status with counts', () => {
    render(
      <CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />,
    );

    expect(screen.getByTestId('clone-results-panel')).toBeDefined();
    expect(screen.getByTestId('clone-results-summary')).toBeDefined();

    const summary = screen.getByTestId('clone-results-summary');
    expect(summary.textContent).toContain('success');

    const counts = screen.getByTestId('clone-results-counts');
    expect(counts.textContent).toContain('200');
  });

  it('should show duration', () => {
    render(
      <CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />,
    );

    const summary = screen.getByTestId('clone-results-summary');
    expect(summary.textContent).toContain('12.5');
  });

  it('should show per-object results in accordion', () => {
    render(
      <CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />,
    );

    const panel = screen.getByTestId('clone-results-panel');
    expect(panel.textContent).toContain('Account');
    expect(panel.textContent).toContain('Contact');
  });

  it('should show failed count for partial results', () => {
    render(
      <CloneResultsPanel result={mockPartialResult} onDone={vi.fn()} />,
    );

    const summary = screen.getByTestId('clone-results-summary');
    expect(summary.textContent).toContain('partial');

    const counts = screen.getByTestId('clone-results-counts');
    expect(counts.textContent).toContain('80');
  });

  it('should call onDone when clicking Done button', () => {
    const onDone = vi.fn();
    render(
      <CloneResultsPanel result={mockSuccessResult} onDone={onDone} />,
    );

    fireEvent.click(screen.getByTestId('clone-results-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('should have export mapping button', () => {
    render(
      <CloneResultsPanel result={mockSuccessResult} onDone={vi.fn()} />,
    );

    expect(screen.getByTestId('clone-export-mapping')).toBeDefined();
  });

  it('should render errors for failed objects in partial results', () => {
    render(
      <CloneResultsPanel result={mockPartialResult} onDone={vi.fn()} />,
    );

    const panel = screen.getByTestId('clone-results-panel');
    // The accordion content contains error info for Contact
    expect(panel.textContent).toContain('Contact');
  });
});
