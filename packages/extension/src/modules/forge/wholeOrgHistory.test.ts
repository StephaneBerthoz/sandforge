import { describe, it, expect } from 'vitest';
import type { ForgeExecutionResult, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { wholeOrgHistoryEntry } from './wholeOrgHistory.js';

/*
 * The history lives in the extension's global state, rewritten whole at every
 * change, twenty runs of it: a clone of the whole org keeps there its nodes,
 * without the thousands of relations and left-out objects its graph names.
 */

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 10,
    fieldCount: 5,
    status: 'done',
    progress: 100,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    errors: [],
    level,
    successCount: 10,
    failureCount: 0,
    createableFieldCount: 4,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

/** The graph a clone of the whole org ran: two objects, a relation, three objects left out. */
function wholeOrgGraph(): ForgeGraph {
  return {
    nodes: [node('Account', 0), node('Contact', 1)],
    edges: [
      {
        sourceObject: 'Contact',
        targetObject: 'Account',
        relationshipName: 'AccountId',
        type: 'lookup',
      },
    ],
    totalRecords: 20,
    estimatedSizeMB: 0.02,
    estimatedDurationSeconds: 1,
    leftOut: [
      { objectApiName: 'AccountHistory', reason: 'history' },
      { objectApiName: 'Widget__c', reason: 'empty' },
      { objectApiName: 'ContactHistory', reason: 'history' },
    ],
  };
}

function resultOf(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'forge-1',
    status: 'success',
    graph: wholeOrgGraph(),
    duration: 10,
    timestamp: '2026-11-13T00:00:00.000Z',
    idRemapCount: 20,
    createdCount: 20,
    ...overrides,
  };
}

describe('wholeOrgHistoryEntry', () => {
  it('keeps the nodes, no relation, and what the run left out counted by reason, the most first', () => {
    const entry = wholeOrgHistoryEntry(resultOf());

    expect(entry.graph.nodes.map((n) => n.objectApiName)).toEqual(['Account', 'Contact']);
    expect(entry.graph.edges).toEqual([]);
    expect(entry.graph.withoutEdges).toBe(true);
    expect(entry.graph).not.toHaveProperty('leftOut');
    expect(entry.leftOutCounts).toEqual([
      { reason: 'history', count: 2 },
      { reason: 'empty', count: 1 },
    ]);
  });

  it('leaves the result the page is answered with whole', () => {
    const result = resultOf();

    wholeOrgHistoryEntry(result);

    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.leftOut).toHaveLength(3);
    expect(result.graph).not.toHaveProperty('withoutEdges');
  });

  it('drops the ids of what goes with a created record once the run keeps its ids in its journal, keeping their count', () => {
    const entry = wholeOrgHistoryEntry(
      resultOf({
        remapInJournal: true,
        idRemapWithTheirRecord: ['003000000000001AAA'],
        withTheirRecordCount: 1,
      }),
    );

    expect(entry).not.toHaveProperty('idRemapWithTheirRecord');
    expect(entry.withTheirRecordCount).toBe(1);
  });

  it('keeps those ids when the entry holds the run’s ids, as any run’s entry does', () => {
    const entry = wholeOrgHistoryEntry(
      resultOf({ idRemapWithTheirRecord: ['003000000000001AAA'] }),
    );

    expect(entry.idRemapWithTheirRecord).toEqual(['003000000000001AAA']);
  });

  it('counts nothing left out when discovery left nothing out', () => {
    const entry = wholeOrgHistoryEntry(
      resultOf({ graph: { ...wholeOrgGraph(), leftOut: undefined } }),
    );

    expect(entry).not.toHaveProperty('leftOutCounts');
    expect(entry.graph.withoutEdges).toBe(true);
  });
});
