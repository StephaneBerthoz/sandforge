import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type { FieldInfo, ForgeExecutorDeps, ForgeProgressEvent } from './ForgeExecutor.js';
import { finishedRunStatus } from './runResult.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A retry runs the clone again against what the run it retries wrote: the
 * rows that run wrote are in the target, linked to and never written twice;
 * the others are written against them.
 */

const idField: FieldInfo = { name: 'Id', queryable: true, createable: false, isReference: false };
const text = (name: string): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  isReference: false,
});
const lookup = (name: string, target: string, nillable: boolean): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  isReference: true,
  referenceTo: [target],
  nillable,
});

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 2,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

function graphOf(nodes: ForgeGraphNode[], edges: ForgeGraphEdge[]): ForgeGraph {
  return { nodes, edges, totalRecords: 4, estimatedSizeMB: 0, estimatedDurationSeconds: 0 };
}

/**
 * A source org holding `tables`, described by `fields`, and a target that
 * creates what it is sent under the ids `created` gives, object by object.
 */
function orgs(
  fields: Record<string, FieldInfo[]>,
  tables: Record<string, Record<string, unknown>[]>,
  created: Record<string, string[]>,
) {
  const inserted: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
  const updated: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => fields[object] ?? [idField]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      return (tables[object] ?? []).map((row) => ({ ...row }));
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      inserted.push({ object, rows });
      const ids = created[object] ?? [];
      return rows.map((_, i) => ({ id: ids[i] ?? '', success: ids[i] !== undefined, errors: [] }));
    }),
    updateRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      updated.push({ object, rows });
      return rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] }));
    }),
  } satisfies ForgeExecutorDeps;
  return { deps, inserted, updated };
}

describe('ForgeExecutor, retrying a run', () => {
  const ACCOUNT = '001000000000001SRC';
  const KEPT = '003000000000001SRC';
  const REFUSED = '003000000000002SRC';

  const fields = {
    Account: [idField, text('Name')],
    Contact: [idField, text('LastName'), lookup('AccountId', 'Account', false)],
  };
  const graph = graphOf(
    [node('Account', 0), node('Contact', 1)],
    [
      {
        sourceObject: 'Account',
        targetObject: 'Contact',
        relationshipName: 'AccountId',
        type: 'lookup',
        required: true,
      },
    ],
  );
  const tables = {
    Account: [{ Id: ACCOUNT, Name: 'Acme' }],
    Contact: [
      { Id: KEPT, LastName: 'Kept', AccountId: ACCOUNT },
      { Id: REFUSED, LastName: 'Refused', AccountId: ACCOUNT },
    ],
  };
  /** What the run retried wrote: the account and one of its two contacts. */
  const writtenBefore = {
    [ACCOUNT]: '001000000000001TGT',
    [KEPT]: '003000000000001TGT',
  };

  it('writes only the rows the run it retries did not, against the records it did', async () => {
    const { deps, inserted } = orgs(fields, tables, { Contact: ['003000000000002TGT'] });

    const summary = await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', () => undefined, {
      writtenBefore,
    });

    expect(inserted).toEqual([
      {
        object: 'Contact',
        rows: [{ LastName: 'Refused', AccountId: '001000000000001TGT' }],
      },
    ]);
    expect(summary.successCount).toBe(1);
    // In the target, so the clone's: counted with the rows the target held.
    expect(summary.linkedCount).toBe(2);
    expect(summary.failedCount).toBe(0);
    expect(finishedRunStatus(summary)).toBe('success');
  });

  it('takes back, when removed, only the rows it wrote itself', async () => {
    const { deps } = orgs(fields, tables, { Contact: ['003000000000002TGT'] });

    const summary = await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', () => undefined, {
      writtenBefore,
    });

    expect(summary.createdByObject).toEqual([{ objectApiName: 'Contact', sourceIds: [REFUSED] }]);
    expect(summary.remapByObject).toEqual([{ objectApiName: 'Contact', created: 1, linked: 0 }]);
    // Its Id map is the clone's whole, the rows the run retried wrote among
    // those the target already held.
    expect(summary.remapTable).toEqual({ ...writtenBefore, [REFUSED]: '003000000000002TGT' });
    expect(summary.existingSourceIds).toEqual([ACCOUNT, KEPT]);
  });

  it('says of each object how many of its rows the run retried had written', async () => {
    const { deps } = orgs(fields, tables, { Contact: ['003000000000002TGT'] });
    const events: ForgeProgressEvent[] = [];

    await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', (e) => events.push(e), {
      writtenBefore,
    });

    const last = (object: string): string | undefined =>
      events.filter((e) => e.objectName === object && e.status === 'done').pop()?.message;
    expect(last('Account')).toBe(
      'Completed Account: 0 succeeded, 1 already in the target from the run retried, 0 failed',
    );
    expect(last('Contact')).toBe(
      'Completed Contact: 1 succeeded, 1 already in the target from the run retried, 0 failed',
    );
  });

  describe('a lookup the run it retries had to leave empty', () => {
    const PROJECT = 'a01000000000001SRC';
    const SPONSOR = 'a02000000000001SRC';
    const projectFields = {
      Sponsor__c: [idField, text('Name')],
      Project__c: [idField, text('Name'), lookup('Lead_Sponsor__c', 'Sponsor__c', true)],
    };
    const projectGraph = graphOf(
      [node('Sponsor__c', 0), node('Project__c', 1)],
      [
        {
          sourceObject: 'Sponsor__c',
          targetObject: 'Project__c',
          relationshipName: 'Lead_Sponsor__c',
          type: 'lookup',
        },
      ],
    );
    /** The run retried wrote the project; its sponsor failed, so the lookup went in empty. */
    const projectWrittenBefore = { [PROJECT]: 'a01000000000001TGT' };

    it('is filled in on the row it wrote once this run writes the record named', async () => {
      const { deps, inserted, updated } = orgs(
        projectFields,
        {
          Sponsor__c: [{ Id: SPONSOR, Name: 'Sponsor' }],
          Project__c: [{ Id: PROJECT, Name: 'Project', Lead_Sponsor__c: SPONSOR }],
        },
        { Sponsor__c: ['a02000000000001TGT'] },
      );

      const summary = await new ForgeExecutor(deps).execute(
        projectGraph,
        'src',
        'tgt',
        () => undefined,
        { writtenBefore: projectWrittenBefore },
      );

      expect(inserted.map((i) => i.object)).toEqual(['Sponsor__c']);
      expect(updated).toEqual([
        {
          object: 'Project__c',
          rows: [{ Id: 'a01000000000001TGT', Lead_Sponsor__c: 'a02000000000001TGT' }],
        },
      ]);
      expect(summary.errors).toEqual([]);
    });

    it('is left unsaid when this run does not write the record named either', async () => {
      // The run retried reported it; the sponsor is gone from the source.
      const { deps, updated } = orgs(
        projectFields,
        {
          Sponsor__c: [],
          Project__c: [{ Id: PROJECT, Name: 'Project', Lead_Sponsor__c: SPONSOR }],
        },
        {},
      );

      const summary = await new ForgeExecutor(deps).execute(
        projectGraph,
        'src',
        'tgt',
        () => undefined,
        { writtenBefore: projectWrittenBefore },
      );

      expect(updated).toEqual([]);
      expect(summary.errors).toEqual([]);
    });

    it('is filled in before a record-scoped run writes what reads it', async () => {
      // A scoped run writes node by node, settling each lookup it can before
      // the next node goes in: an opportunity's price book has to be there
      // before its line items are.
      const LINE = 'a03000000000001SRC';
      const { deps } = orgs(
        {
          ...projectFields,
          Task__c: [idField, text('Name'), lookup('Project__c', 'Project__c', false)],
        },
        {
          Sponsor__c: [{ Id: SPONSOR, Name: 'Sponsor' }],
          Project__c: [{ Id: PROJECT, Name: 'Project', Lead_Sponsor__c: SPONSOR }],
          Task__c: [{ Id: LINE, Name: 'Task', Project__c: PROJECT }],
        },
        { Sponsor__c: ['a02000000000001TGT'], Task__c: ['a03000000000001TGT'] },
      );
      const calls: string[] = [];
      deps.insertRecords.mockImplementation(async (_org, object, rows) => {
        calls.push(`insert ${object}`);
        return rows.map(() => ({
          id: object === 'Sponsor__c' ? 'a02000000000001TGT' : 'a03000000000001TGT',
          success: true,
          errors: [],
        }));
      });
      deps.updateRecords.mockImplementation(async (_org, object, rows) => {
        calls.push(`update ${object}`);
        return rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] }));
      });
      const scopedGraph = graphOf(
        [node('Project__c', 0), node('Sponsor__c', 1), node('Task__c', 1)],
        [
          ...projectGraph.edges,
          {
            sourceObject: 'Project__c',
            targetObject: 'Task__c',
            relationshipName: 'Project__c',
            type: 'lookup',
            required: true,
          },
        ],
      );

      await new ForgeExecutor(deps).execute(scopedGraph, 'src', 'tgt', () => undefined, {
        rootRecordId: PROJECT,
        rootObjectApiName: 'Project__c',
        writtenBefore: projectWrittenBefore,
      });

      expect(calls.indexOf('update Project__c')).toBeGreaterThan(-1);
      expect(calls.indexOf('update Project__c')).toBeLessThan(calls.indexOf('insert Task__c'));
    });
  });
});
