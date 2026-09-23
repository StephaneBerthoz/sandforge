import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ForgeGraph } from '@sandforge/shared';
import type { ExecutionSummary } from './ForgeExecutor.js';
import { finishedRunStatus, forgeRunResult } from './runResult.js';

const GRAPH: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 3,
  estimatedSizeMB: 0.1,
  estimatedDurationSeconds: 4,
};

/** A run that created an Account and a Contact, and linked an Account the target held. */
function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    successCount: 2,
    updatedCount: 0,
    linkedCount: 1,
    wouldInsertCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 3,
    errors: [],
    truncatedObjects: [],
    remapTable: {
      '001000000000001SRC': '001000000000001AAA',
      '001000000000002SRC': '001000000000002AAA',
      '003000000000001SRC': '003000000000001AAA',
    },
    existingRecords: [{ objectApiName: 'Account', linked: 1, unidentified: 0 }],
    existingSourceIds: ['001000000000002SRC'],
    updatedSourceIds: [],
    remapByObject: [
      { objectApiName: 'Account', created: 1, linked: 1 },
      { objectApiName: 'Contact', created: 1, linked: 0 },
    ],
    createdByObject: [
      { objectApiName: 'Account', sourceIds: ['001000000000001SRC'] },
      { objectApiName: 'Contact', sourceIds: ['003000000000001SRC'] },
    ],
    ...overrides,
  };
}

describe('finishedRunStatus', () => {
  it('calls a run with no failure a success', () => {
    expect(finishedRunStatus(summary())).toBe('success');
  });

  it('calls a run that failed some records and settled others partial, however it settled them', () => {
    const failing = { successCount: 0, updatedCount: 0, linkedCount: 0, failedCount: 3 };

    expect(finishedRunStatus({ ...failing, successCount: 1 })).toBe('partial');
    expect(finishedRunStatus({ ...failing, updatedCount: 1 })).toBe('partial');
    expect(finishedRunStatus({ ...failing, linkedCount: 1 })).toBe('partial');
  });

  it('calls a run that settled none of the records it tried a failure', () => {
    expect(
      finishedRunStatus({ successCount: 0, updatedCount: 0, linkedCount: 0, failedCount: 3 }),
    ).toBe('failure');
  });
});

describe('forgeRunResult', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records what the run created, what it linked and where each record went', () => {
    const startedAt = Date.parse('2026-09-23T09:59:30.000Z');

    expect(forgeRunResult(summary(), GRAPH, { startedAt, status: 'success' })).toEqual({
      forgeId: `forge-${Date.parse('2026-09-23T10:00:00.000Z')}`,
      status: 'success',
      graph: GRAPH,
      duration: 30_000,
      timestamp: '2026-09-23T10:00:00.000Z',
      idRemapCount: 3,
      idRemapTable: summary().remapTable,
      idRemapExisting: ['001000000000002SRC'],
      createdCount: 2,
      linkedExistingCount: 1,
      existingRecords: [{ objectApiName: 'Account', linked: 1, unidentified: 0 }],
      idRemapByObject: summary().remapByObject,
      idRemapCreated: summary().createdByObject,
      errors: [],
      truncatedObjects: [],
    });
  });

  it('says how many records an upsert wrote over only for a run that did', () => {
    const run = { startedAt: Date.now(), status: 'success' as const };

    expect(forgeRunResult(summary(), GRAPH, run)).not.toHaveProperty('updatedCount');
    expect(forgeRunResult(summary({ updatedCount: 4 }), GRAPH, run).updatedCount).toBe(4);
  });

  it('keeps what a run that stopped part way created, under the status it is given', () => {
    const stopped = forgeRunResult(summary({ failedCount: 5 }), GRAPH, {
      startedAt: Date.now(),
      status: 'failure',
    });

    expect(stopped.status).toBe('failure');
    expect(stopped.idRemapCreated).toEqual(summary().createdByObject);
  });
});
