import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeResults } from './ForgeResults';

/* ---- Mocks ---- */

function makeNode(overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName: 'Account',
    recordCount: 10,
    fieldCount: 15,
    status: 'done',
    progress: 100,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 10,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

function makeGraph(): ForgeGraph {
  return {
    // Every column sorts Contact above Account, so an assertion on the first
    // row proves the clicked header is the one that took effect.
    nodes: [
      makeNode({ objectApiName: 'Account', recordCount: 20, status: 'skipped' }),
      makeNode({ objectApiName: 'Contact', recordCount: 10, status: 'done' }),
    ],
    edges: [],
    totalRecords: 30,
    estimatedSizeMB: 1,
    estimatedDurationSeconds: 10,
  };
}

vi.mock('../../stores/useForgeStore', () => ({
  useForgeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      graph: makeGraph(),
      result: null,
      forgeAgain: vi.fn(),
      setPhase: vi.fn(),
      setGraph: vi.fn(),
      logs: [],
    }),
}));

/* ---- Tests ---- */

describe('ForgeResults sortable headers', () => {
  const headers = [
    'forge-results-sort-object',
    'forge-results-sort-records',
    'forge-results-sort-status',
  ] as const;

  it.each(headers)('should expose %s as a button inside its th', (testId) => {
    render(<ForgeResults />);
    const trigger = screen.getByTestId(testId);
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');
    expect(trigger.closest('th')).not.toBeNull();
  });

  it.each(headers)('should announce the sort state of %s on the th', (testId) => {
    render(<ForgeResults />);
    const trigger = screen.getByTestId(testId);
    const header = trigger.closest('th');

    fireEvent.click(trigger);
    // Default sort is objectApiName ascending, so the first click on that
    // column flips it to descending while the others start ascending.
    const expected = testId === 'forge-results-sort-object' ? 'descending' : 'ascending';
    expect(header?.getAttribute('aria-sort')).toBe(expected);
    expect(screen.getAllByTestId('forge-results-row')[0].textContent).toContain('Contact');
  });

  it('should leave aria-sort unset on columns that are not the active sort', () => {
    render(<ForgeResults />);
    const records = screen.getByTestId('forge-results-sort-records');
    expect(records.closest('th')?.getAttribute('aria-sort')).toBeNull();

    fireEvent.click(records);
    expect(records.closest('th')?.getAttribute('aria-sort')).toBe('ascending');
    expect(
      screen.getByTestId('forge-results-sort-object').closest('th')?.getAttribute('aria-sort'),
    ).toBeNull();
  });
});
