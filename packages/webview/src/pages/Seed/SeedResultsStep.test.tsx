import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SeedExecutionResult, SeedObjectResult } from '@sandforge/shared';
import '../../i18n';
import { SeedResultsStep } from './SeedResultsStep';

function objectResult(overrides: Partial<SeedObjectResult> = {}): SeedObjectResult {
  return {
    objectApiName: 'Contact',
    recordsCreated: 10,
    recordsFailed: 0,
    createdIds: [],
    errors: [],
    ...overrides,
  };
}

function executionResult(objectResults: SeedObjectResult[]): SeedExecutionResult {
  return {
    templateId: 'tpl-1',
    operationId: 'op-1',
    status: 'success',
    objectResults,
    totalRecordsCreated: 10,
    totalRecordsFailed: 0,
    duration: 1200,
    timestamp: '2026-01-01T00:00:00Z',
  };
}

describe('SeedResultsStep', () => {
  it('names the fields that received generated sentences instead of AI values', () => {
    render(
      <SeedResultsStep
        executionResult={executionResult([
          objectResult({ aiFallback: { fields: ['Description', 'Title'], reason: 'no-answer' } }),
          objectResult({ objectApiName: 'Account' }),
        ])}
        onSeedAgain={vi.fn()}
      />,
    );

    const rows = screen.getAllByTestId('seed-result-ai-fallback');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Description, Title');
  });

  it('says a short AI answer apart from no answer', () => {
    render(
      <SeedResultsStep
        executionResult={executionResult([
          objectResult({ aiFallback: { fields: ['Title'], reason: 'short-answer' } }),
        ])}
        onSeedAgain={vi.fn()}
      />,
    );

    const row = screen.getByTestId('seed-result-ai-fallback');
    expect(row.textContent).toContain('Title');
    expect(row.textContent).toContain('left values out');
    expect(row.textContent).not.toContain('refused');
  });

  it('shows no fallback row when every AI field got an AI value', () => {
    render(
      <SeedResultsStep executionResult={executionResult([objectResult()])} onSeedAgain={vi.fn()} />,
    );

    expect(screen.queryByTestId('seed-result-ai-fallback')).toBeNull();
  });
});
