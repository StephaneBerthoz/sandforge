import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';

import { ForgeResults } from './ForgeResults';

/**
 * The source -> target Id map.
 *
 * ForgeExecutor has always built it (IdRemapper.toJSON) and returned it as
 * ExecutionSummary.remapTable, and ForgeOrchestrator projected only its length
 * into the result. A finished clone could therefore report "312 records" while
 * being unable to answer "where did this Account go in the new sandbox?".
 */

const graph = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 2,
      fieldCount: 5,
      status: 'done' as const,
      progress: 100,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 2,
      failureCount: 0,
      errors: [],
      createableFieldCount: 4,
      estimatedSizeMB: 0,
      estimatedApiCalls: 1,
      batchStrategy: 'auto' as const,
    },
  ],
  edges: [],
  totalRecords: 2,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

/** ForgeResults reads the result from the store, not from props. */
let mockResult: Record<string, unknown> | null = null;

vi.mock('../../stores/useForgeStore', () => ({
  useForgeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        graph,
        logs: [],
        setPhase: vi.fn(),
        reset: vi.fn(),
        history: [],
        get result() {
          return mockResult;
        },
      }),
    { getState: () => ({ graph, logs: [] }) },
  ),
}));

const baseResult = {
  forgeId: 'forge-1',
  status: 'success' as const,
  graph,
  duration: 1000,
  timestamp: '2026-01-01T00:00:00Z',
  idRemapCount: 2,
};

describe('Forge results — record Id mapping', () => {
  it('lists every source -> target pair the run created', () => {
    mockResult = {
      ...baseResult,
      idRemapTable: {
        '001SRC000000001': '001TGT000000001',
        '001SRC000000002': '001TGT000000002',
      },
    };
    render(<ForgeResults />);

    expect(screen.getByTestId('forge-id-mapping')).toBeDefined();
    expect(screen.getAllByTestId('forge-id-mapping-row')).toHaveLength(2);
    expect(screen.getByText('001SRC000000001')).toBeDefined();
    expect(screen.getByText('001TGT000000001')).toBeDefined();
  });

  it('renders nothing when the run produced no mapping', () => {
    // A failed run creates no records; an empty table is not worth a heading.
    mockResult = { ...baseResult, idRemapCount: 0, idRemapTable: {} };
    render(<ForgeResults />);
    expect(screen.queryByTestId('forge-id-mapping')).toBeNull();
  });

  it('renders nothing for a run recorded before the table existed', () => {
    mockResult = { ...baseResult };
    render(<ForgeResults />);
    expect(screen.queryByTestId('forge-id-mapping')).toBeNull();
  });
});
