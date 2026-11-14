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

  describe('of a sample of the whole org', () => {
    /*
     * What a run of a sample reports, as the run's result builds it from its
     * plan's report: the plan's report holds the id of each root it set
     * aside and the path of the plan, which a result spread from it carries
     * along.
     */
    const written = {
      objectApiName: 'Account',
      sourceRows: 18_400,
      kept: 712,
      roots: 500,
      below: 0,
      asParents: 212,
      childrenCut: [{ field: 'ParentId', rows: 3 }],
      written: 710,
      goneSinceTheSample: 2,
      changedSinceTheSample: 0,
    };
    const sampled = (): ForgeExecutionResult =>
      resultOf({
        sample: {
          seed: 1,
          draw: 'uniform',
          share: 0.0041,
          sha256: 'c'.repeat(64),
          drawnAt: '2026-11-14T14:02:00.000Z',
          objects: [written],
          // Carried along from the plan's report, as a spread brings them.
          ...({
            heavyRoots: [{ objectApiName: 'Account', id: '001000000000002AAA', rows: 900 }],
            plan: { path: '/storage/forge-runs/x.sample', sha256: 'c'.repeat(64) },
          } as object),
        },
        config: {
          inputMode: 'org',
          depth: 'all',
          maxNodes: 0,
          anonymizePII: true,
          sample: { withinMB: 3, seed: 1, plan: '/storage/forge-samples/abc' },
        } as ForgeExecutionResult['config'],
      });

    it('keeps the seed, the draw, the share, the SHA-256 of the plan and the counts per object, and no id nor path', () => {
      const entry = wholeOrgHistoryEntry(sampled());

      expect(entry.sample).toEqual({
        seed: 1,
        draw: 'uniform',
        share: 0.0041,
        sha256: 'c'.repeat(64),
        drawnAt: '2026-11-14T14:02:00.000Z',
        objects: [written],
      });
      expect(JSON.stringify(entry)).not.toMatch(/001000000000002AAA|forge-runs|forge-samples/);
    });

    // A lookup the run wrote empty, its record outside the plan, is no
    // failure: the history says how many, per field, as the results did.
    it('keeps the lookups the run wrote empty, per object and field', () => {
      const leftEmpty = [{ objectApiName: 'Case', field: 'ContactId', rows: 40 }];
      const result = sampled();
      const entry = wholeOrgHistoryEntry({
        ...result,
        ...(result.sample ? { sample: { ...result.sample, leftEmpty } } : {}),
      });

      expect(entry.sample?.leftEmpty).toEqual(leftEmpty);
    });

    // Run again from the history, a sample is drawn again with the same
    // options: the plan of a dry run it was given is a day's at most, and
    // names records of a production.
    it('keeps the options of the sample to draw it again, and not the plan it was given', () => {
      const entry = wholeOrgHistoryEntry(sampled());

      expect(entry.config?.sample).toEqual({ withinMB: 3, seed: 1 });
    });

    it('leaves the result the page is answered with whole', () => {
      const result = sampled();

      wholeOrgHistoryEntry(result);

      expect(result.config?.sample).toHaveProperty('plan');
      expect(result.sample).toHaveProperty('heavyRoots');
    });
  });
});
