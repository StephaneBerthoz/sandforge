import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeAbortedError, ForgeExecutor } from './ForgeExecutor.js';
import type { FieldInfo, ForgeExecutorDeps } from './ForgeExecutor.js';
import { partialSummaryOf } from './interruptedRun.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A run cancelled while its second pass fills in the lookups the insert left
 * empty: the pass stops between two calls, and the run ends cancelled with
 * what the pass had filled and what it left.
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

function node(objectApiName: string, level: number, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
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
    batchStrategy: 'rest',
  };
}

function graphOf(nodes: ForgeGraphNode[], edges: ForgeGraphEdge[]): ForgeGraph {
  return { nodes, edges, totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 };
}

/** A fake id of `prefix` whose first twelve characters tell it apart. */
const fakeId = (prefix: string, n: number): string =>
  `${prefix}Fk${String(n).padStart(7, '0')}SrCIA`;

/**
 * A source org holding `tables`, described by `fields`, and a target that
 * creates what it is sent, and aborts `executor` as the first update of the
 * second pass reaches it.
 */
function orgsAbortingAtTheFirstUpdate(
  fields: Record<string, FieldInfo[]>,
  tables: Record<string, Record<string, unknown>[]>,
) {
  const holder: { executor?: ForgeExecutor } = {};
  let created = 0;
  const updated: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => fields[object] ?? [idField]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      return (tables[object] ?? []).map((row) => ({ ...row }));
    }),
    insertRecords: vi.fn(async (_org: string, _object: string, rows: Record<string, unknown>[]) =>
      rows.map(() => ({
        id: `TGT${String(created++).padStart(12, '0')}`,
        success: true,
        errors: [],
      })),
    ),
    updateRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      updated.push({ object, rows });
      holder.executor?.abort();
      return rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] }));
    }),
  } satisfies ForgeExecutorDeps;
  const executor = new ForgeExecutor(deps);
  holder.executor = executor;
  return { executor, updated };
}

/** What the second pass says of a cancel that kept `count` lookups of `object` from being sent. */
const notSent = (object: string, count: number) => ({
  recordSummary: `${object}: ${count} lookups not sent`,
  messages: ['The run was cancelled before they were filled in: they stay empty.'],
});

describe('ForgeExecutor, cancelled during the second pass', () => {
  it('stops the pass that ends a full-table run between two calls, and keeps what it filled and left with the run', async () => {
    // An account's key contact against a contact's account: the accounts go
    // first, their key contact empty, filled in once the contacts are in —
    // 250 lookups, two calls. The pass sent both after the cancel, and the
    // run ended as one nobody had cancelled.
    const accounts = Array.from({ length: 250 }, (_, n) => ({
      Id: fakeId('001', n),
      Name: `Account ${n}`,
      Key_Contact__c: fakeId('003', n),
    }));
    const contacts = Array.from({ length: 250 }, (_, n) => ({
      Id: fakeId('003', n),
      LastName: `Contact ${n}`,
      AccountId: fakeId('001', n),
    }));
    const { executor, updated } = orgsAbortingAtTheFirstUpdate(
      {
        Account: [idField, text('Name'), lookup('Key_Contact__c', 'Contact', true)],
        Contact: [idField, text('LastName'), lookup('AccountId', 'Account', false)],
      },
      { Account: accounts, Contact: contacts },
    );
    const graph = graphOf(
      [node('Account', 0, 250), node('Contact', 1, 250)],
      [
        {
          sourceObject: 'Account',
          targetObject: 'Contact',
          relationshipName: 'AccountId',
          type: 'lookup',
          required: true,
        },
        {
          sourceObject: 'Contact',
          targetObject: 'Account',
          relationshipName: 'Key_Contact__c',
          type: 'lookup',
        },
      ],
    );

    const error = await executor.execute(graph, 'src', 'tgt', () => undefined).catch((e) => e);

    expect(error).toBeInstanceOf(ForgeAbortedError);
    expect(updated.map(({ object, rows }) => [object, rows.length])).toEqual([['Account', 200]]);
    const partial = partialSummaryOf(error);
    expect(partial?.successCount).toBe(500);
    expect(partial?.errors).toEqual([
      {
        objectApiName: '__pass2__',
        stage: 'insert',
        failedCount: 50,
        attemptedCount: 250,
        samples: [notSent('Account', 50)],
      },
    ]);
  });

  it('stops the pass that settles a node of a record-scoped run, and says what it left', async () => {
    // Each task names the next one, written after it: 249 lookups the node's
    // own write leaves empty, settled before the next node — in two calls.
    const PROJECT = fakeId('a01', 0);
    const tasks = Array.from({ length: 250 }, (_, n) => ({
      Id: fakeId('a02', n),
      Name: `Task ${n}`,
      Project__c: PROJECT,
      Next_Task__c: n === 249 ? null : fakeId('a02', n + 1),
    }));
    const { executor, updated } = orgsAbortingAtTheFirstUpdate(
      {
        Project__c: [idField, text('Name')],
        Task__c: [
          idField,
          text('Name'),
          lookup('Project__c', 'Project__c', false),
          lookup('Next_Task__c', 'Task__c', true),
        ],
      },
      { Project__c: [{ Id: PROJECT, Name: 'Project' }], Task__c: tasks },
    );
    const graph = graphOf(
      [node('Project__c', 0, 1), node('Task__c', 1, 250)],
      [
        {
          sourceObject: 'Project__c',
          targetObject: 'Task__c',
          relationshipName: 'Project__c',
          type: 'lookup',
          required: true,
        },
      ],
    );

    const error = await executor
      .execute(graph, 'src', 'tgt', () => undefined, {
        rootRecordId: PROJECT,
        rootObjectApiName: 'Project__c',
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ForgeAbortedError);
    expect(updated.map(({ object, rows }) => [object, rows.length])).toEqual([['Task__c', 200]]);
    expect(partialSummaryOf(error)?.errors).toEqual([
      {
        objectApiName: '__pass2__',
        stage: 'insert',
        failedCount: 49,
        attemptedCount: 249,
        samples: [notSent('Task__c', 49)],
      },
    ]);
  });
});
