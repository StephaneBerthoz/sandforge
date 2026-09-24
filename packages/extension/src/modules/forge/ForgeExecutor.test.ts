import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForgeExecutor, ForgeAbortedError } from './ForgeExecutor.js';
import { partialSummaryOf } from './interruptedRun.js';
import { finishedRunStatus } from './runResult.js';
import type { ForgeExecutorDeps, ForgeProgressEvent, FieldInfo } from './ForgeExecutor.js';
import type { ForgeGraph, ForgeGraphNode, ForgeGraphEdge } from '@sandforge/shared';
import { STANDARD_PRICEBOOK_SOQL } from '@sandforge/shared';
import { logger } from '../../logger.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Default field metadata returned by describeFields mock. */
const DEFAULT_FIELDS: FieldInfo[] = [
  { name: 'Id', queryable: true, createable: false, isReference: false },
  { name: 'Name', queryable: true, createable: true, isReference: false },
];

function createMockDeps(): ForgeExecutorDeps {
  return {
    queryRecords: vi.fn<ForgeExecutorDeps['queryRecords']>().mockResolvedValue([
      { Id: '001OLD1', Name: 'Record 1' },
      { Id: '001OLD2', Name: 'Record 2' },
    ]),
    insertRecords: vi.fn<ForgeExecutorDeps['insertRecords']>().mockResolvedValue([
      { id: '001NEW1', success: true, errors: [] },
      { id: '001NEW2', success: true, errors: [] },
    ]),
    describeFields: vi.fn<ForgeExecutorDeps['describeFields']>().mockResolvedValue(DEFAULT_FIELDS),
  };
}

function makeNode(objectApiName: string, overrides?: Partial<ForgeGraphNode>): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 2,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

function makeGraph(nodes: ForgeGraphNode[], edges: ForgeGraphEdge[] = []): ForgeGraph {
  const totalRecords = nodes.reduce((s, n) => s + n.recordCount, 0);
  return {
    nodes,
    edges,
    totalRecords,
    estimatedSizeMB: totalRecords * 0.001,
    estimatedDurationSeconds: totalRecords * 0.01,
  };
}

describe('ForgeExecutor', () => {
  let deps: ForgeExecutorDeps;
  let executor: ForgeExecutor;
  let progressEvents: ForgeProgressEvent[];

  function onProgress(event: ForgeProgressEvent): void {
    progressEvents.push(event);
  }

  beforeEach(() => {
    deps = createMockDeps();
    executor = new ForgeExecutor(deps);
    progressEvents = [];
  });

  describe('basic execution', () => {
    it('should execute a single-node graph successfully', async () => {
      const graph = makeGraph([makeNode('Account')]);
      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.successCount).toBe(2);
      expect(summary.failedCount).toBe(0);
      expect(summary.skippedCount).toBe(0);
    });

    it('should describe fields and query records from source org', async () => {
      const graph = makeGraph([makeNode('Account')]);
      await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(deps.describeFields).toHaveBeenCalledWith('src', 'Account');
      expect(deps.queryRecords).toHaveBeenCalledWith(
        'src',
        'SELECT Id, Name FROM Account',
        expect.any(Function),
      );
    });

    it('reports an object whose source read stopped on a bound', async () => {
      // The read is capped at 50 000 records / 500 pages. A clone cut short
      // there used to finish as a plain success, with the shortfall written
      // only to the output channel.
      vi.mocked(deps.queryRecords).mockImplementation(async (_orgId, _soql, onTruncated) => {
        onTruncated?.();
        return [{ Id: '001OLD1', Name: 'Record 1' }];
      });
      const graph = makeGraph([makeNode('Account'), makeNode('Contact')]);

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.truncatedObjects).toEqual(['Account', 'Contact']);
    });

    it('reports no truncation when every read reached the end of its cursor', async () => {
      const graph = makeGraph([makeNode('Account')]);

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.truncatedObjects).toEqual([]);
    });

    it('should insert only createable fields into target org', async () => {
      const graph = makeGraph([makeNode('Account')]);
      await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(deps.insertRecords).toHaveBeenCalledWith('tgt', 'Account', [
        { Name: 'Record 1' },
        { Name: 'Record 2' },
      ]);
    });
  });

  describe('topological ordering', () => {
    it('should process parent before child', async () => {
      const insertOrder: string[] = [];
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objectName) => {
        insertOrder.push(objectName);
        return [{ id: '001NEW', success: true, errors: [] }];
      });
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: '001OLD', Name: 'Rec' }]);

      const graph = makeGraph(
        [makeNode('Contact'), makeNode('Account')],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
      );

      await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(insertOrder.indexOf('Account')).toBeLessThan(insertOrder.indexOf('Contact'));
    });

    it('writes a full-table cycle in the order its required lookup sets', async () => {
      // A quote cannot be written without its opportunity, which points back
      // at the quote synced to it. Discovery met the quote first, and a
      // full-table run wrote the cycle in the order the graph held it: the
      // quote went first and the platform refused it for want of the
      // opportunity, where the plan and a record-scoped run write the
      // opportunity first and fill in its lookup to the quote afterwards.
      const insertOrder: string[] = [];
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objectName) => {
        insertOrder.push(objectName);
        return [{ id: '001NEW', success: true, errors: [] }];
      });
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: '001OLD', Name: 'Rec' }]);
      const graph = makeGraph(
        [makeNode('Quote'), makeNode('Opportunity')],
        [
          {
            sourceObject: 'Opportunity',
            targetObject: 'Quote',
            relationshipName: 'Opportunity',
            type: 'lookup',
            required: true,
          },
          {
            sourceObject: 'Quote',
            targetObject: 'Opportunity',
            relationshipName: 'SyncedQuote',
            type: 'lookup',
          },
        ],
      );

      await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(insertOrder).toEqual(['Opportunity', 'Quote']);
    });
  });

  describe('ID remapping', () => {
    it('should remap lookup fields in child records', async () => {
      vi.mocked(deps.describeFields).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            { name: 'Name', queryable: true, createable: true, isReference: false },
          ];
        }
        // Contact has AccountId as a lookup reference field
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'Name', queryable: true, createable: true, isReference: false },
          { name: 'AccountId', queryable: true, createable: true, isReference: true },
        ];
      });
      vi.mocked(deps.queryRecords).mockImplementation(async (_orgId, soql) => {
        if (soql.includes('FROM Account')) {
          return [{ Id: '001PARENT', Name: 'Acme' }];
        }
        return [{ Id: '003CHILD', AccountId: '001PARENT', Name: 'John' }];
      });
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return [{ id: '001NEWPARENT', success: true, errors: [] }];
        }
        return [{ id: '003NEWCHILD', success: true, errors: [] }];
      });

      const graph = makeGraph(
        [makeNode('Account', { recordCount: 1 }), makeNode('Contact', { recordCount: 1 })],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
      );

      await executor.execute(graph, 'src', 'tgt', onProgress);

      // Second insertRecords call (Contact) should have remapped AccountId
      const contactInsertCall = vi
        .mocked(deps.insertRecords)
        .mock.calls.find((call) => call[1] === 'Contact');
      expect(contactInsertCall).toBeDefined();
      const contactRecords = contactInsertCall![2];
      expect(contactRecords[0].AccountId).toBe('001NEWPARENT');
    });

    it('should track remap count in summary', async () => {
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: '001X', Name: 'Rec' }]);
      vi.mocked(deps.insertRecords).mockResolvedValue([{ id: '001Y', success: true, errors: [] }]);

      const graph = makeGraph([makeNode('Account', { recordCount: 1 })]);
      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.remapCount).toBe(1);
    });
  });

  describe('excluded nodes', () => {
    it('should skip nodes that are not included', async () => {
      const graph = makeGraph([makeNode('Account', { included: false })]);
      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.skippedCount).toBe(1);
      expect(summary.successCount).toBe(0);
      expect(deps.queryRecords).not.toHaveBeenCalled();
    });

    it('should emit skipped progress for excluded nodes', async () => {
      const graph = makeGraph([makeNode('Account', { included: false })]);
      await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].status).toBe('skipped');
    });

    /** The message the skip of `objectName` gave. */
    const skipOf = (objectName: string): string | undefined =>
      progressEvents.find((e) => e.objectName === objectName && e.status === 'skipped')?.message;

    it('says the error discovery left an object out for, and nothing more for one left out without', async () => {
      // Discovery keeps an object it could not count in the graph, excluded,
      // with the error the org gave. Its skip said "(excluded)" only, as the
      // skip of an empty table does: run between two sandboxes, fourteen such
      // lines named no reason.
      const graph = makeGraph([
        makeNode('Account', { included: false, recordCount: 0 }),
        makeNode('EmailStatus', {
          included: false,
          recordCount: 0,
          status: 'error',
          errors: [
            'Record count unavailable: INVALID_TYPE_FOR_OPERATION: entity type EmailStatus does not support query',
          ],
        }),
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(skipOf('EmailStatus')).toBe(
        'Skipped EmailStatus (excluded: Record count unavailable: INVALID_TYPE_FOR_OPERATION: ' +
          'entity type EmailStatus does not support query)',
      );
      expect(skipOf('Account')).toBe('Skipped Account (excluded)');
    });

    it('says the error of an object left out on the one line of its skip', async () => {
      // An error from Salesforce can run over several lines — the statement,
      // a caret under the column — and the clone command prints one per object.
      const graph = makeGraph([
        makeNode('Contact', {
          included: false,
          recordCount: 0,
          status: 'error',
          errors: [
            "Record count unavailable: INVALID_FIELD: \nSELECT COUNT() FROM Contact WHERE (Bogus__c = 'x')\n" +
              "                                   ^\nERROR at Row:1:Column:36\nNo such column 'Bogus__c' on entity 'Contact'.",
          ],
        }),
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(skipOf('Contact')).toBe(
        "Skipped Contact (excluded: Record count unavailable: INVALID_FIELD: SELECT COUNT() FROM Contact WHERE (Bogus__c = 'x') " +
          "^ ERROR at Row:1:Column:36 No such column 'Bogus__c' on entity 'Contact'.)",
      );
    });
  });

  describe('error handling', () => {
    it('should handle insert failures', async () => {
      vi.mocked(deps.insertRecords).mockResolvedValue([
        { id: '', success: false, errors: ['REQUIRED_FIELD_MISSING'] },
        { id: '001NEW', success: true, errors: [] },
      ]);

      const graph = makeGraph([makeNode('Account')]);
      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.successCount).toBe(1);
      expect(summary.failedCount).toBe(1);
    });

    it('should mark children as skipped when a parent they require completely fails', async () => {
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return [
            { id: '', success: false, errors: ['FAIL'] },
            { id: '', success: false, errors: ['FAIL'] },
          ];
        }
        return [{ id: '003NEW', success: true, errors: [] }];
      });

      // Required: any failed parent used to skip the children, and a child
      // that can do without it is now written with that lookup left empty.
      const graph = makeGraph(
        [makeNode('Account'), makeNode('Contact')],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
            required: true,
          },
        ],
      );

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.skippedCount).toBe(1); // Contact skipped
      expect(summary.failedCount).toBe(2); // Account records
    });

    it('does not skip children of a parent the target already held', async () => {
      // DUPLICATE_VALUE is a unique index refusing a row that is there. The
      // child's lookup resolves to something real, so the subtree is not
      // orphaned and must not be dropped.
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return [
            { id: '', success: false, errors: ['DUPLICATE_VALUE: duplicate value found'] },
            { id: '', success: false, errors: ['DUPLICATE_VALUE: duplicate value found'] },
          ];
        }
        return [
          { id: '003NEW1', success: true, errors: [] },
          { id: '003NEW2', success: true, errors: [] },
        ];
      });

      const graph = makeGraph(
        [makeNode('Account'), makeNode('Contact')],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
      );

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.skippedCount).toBe(0);
      // The rows were still not written, and the run still says so.
      expect(summary.failedCount).toBe(2);
      expect(vi.mocked(deps.insertRecords).mock.calls.some((c) => c[1] === 'Contact')).toBe(true);
    });

    describe('a parent that mostly failed', () => {
      // Required: only a parent the rows cannot be written without takes them
      // down. A failed optional one leaves the lookup at it empty instead.
      const accountToContact: ForgeGraphEdge = {
        sourceObject: 'Account',
        targetObject: 'Contact',
        relationshipName: 'Contacts',
        type: 'lookup',
        required: true,
      };

      /** Ten Accounts of which `failures` are refused by the target org. */
      function failAccounts(failures: number): void {
        vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) =>
          soql.includes('FROM Account')
            ? Array.from({ length: 10 }, (_, i) => ({ Id: `001OLD${i}`, Name: `A${i}` }))
            : [{ Id: '003OLD1', Name: 'C' }],
        );
        vi.mocked(deps.insertRecords).mockImplementation(async (_o, objectName, recs) =>
          recs.map((_, i) =>
            objectName === 'Account' && i < failures
              ? { id: '', success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'] }
              : { id: `NEW${objectName}${i}`, success: true, errors: [] },
          ),
        );
      }

      it('skips the children when 7 of 10 parent records failed', async () => {
        failAccounts(7);
        const graph = makeGraph(
          [makeNode('Account', { recordCount: 10 }), makeNode('Contact')],
          [accountToContact],
        );

        const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

        expect(summary.successCount).toBe(3);
        expect(summary.failedCount).toBe(7);
        expect(summary.skippedCount).toBe(1);
        expect(vi.mocked(deps.insertRecords).mock.calls.map((c) => c[1])).toEqual(['Account']);
        const accountEnd = progressEvents.filter((e) => e.objectName === 'Account').pop();
        expect(accountEnd?.status).toBe('error');
        expect(accountEnd?.message).toContain('7/10');
        expect(
          progressEvents.find((e) => e.objectName === 'Contact' && e.status === 'skipped')?.message,
        ).toContain('parent failed');
      });

      it('still clones the children when 4 of 10 parent records failed', async () => {
        failAccounts(4);
        const graph = makeGraph(
          [makeNode('Account', { recordCount: 10 }), makeNode('Contact')],
          [accountToContact],
        );

        const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

        expect(summary.successCount).toBe(7);
        expect(summary.failedCount).toBe(4);
        expect(summary.skippedCount).toBe(0);
        expect(vi.mocked(deps.insertRecords).mock.calls.map((c) => c[1])).toEqual([
          'Account',
          'Contact',
        ]);
        const accountEnd = progressEvents.filter((e) => e.objectName === 'Account').pop();
        expect(accountEnd?.status).toBe('done');
      });
    });

    describe('a parent that failed in a run that reads whole tables', () => {
      const ACCOUNT = '001000000000001AAA';
      const TERRITORY = 'a0T000000000001AAA';
      const idField: FieldInfo = {
        name: 'Id',
        queryable: true,
        createable: false,
        isReference: false,
      };
      const text = (name: string): FieldInfo => ({
        name,
        queryable: true,
        createable: true,
        isReference: false,
      });
      const lookup = (name: string, target: string, required = false): FieldInfo => ({
        name,
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: [target],
        nillable: !required,
      });

      /**
       * A run of whole tables — no record to start from, so ids are kept as
       * they are by default — whose accounts the target refuses, every one. A
       * contact can do without its account and names a territory the run does
       * not write; a contract cannot do without its account, which only its
       * field says: the graph's edge is that of a lookup discovery never
       * walked.
       */
      async function runWithAccountsRefused() {
        const tables: Record<string, Array<Record<string, unknown>>> = {
          Account: [{ Id: ACCOUNT, Name: 'Acme' }],
          Contact: [
            {
              Id: '003000000000001AAA',
              LastName: 'Doe',
              AccountId: ACCOUNT,
              Territory__c: TERRITORY,
            },
          ],
          Contract: [{ Id: '800000000000001AAA', Name: 'Frame', AccountId: ACCOUNT }],
        };
        const fields: Record<string, FieldInfo[]> = {
          Account: [idField, text('Name')],
          Contact: [
            idField,
            text('LastName'),
            lookup('AccountId', 'Account'),
            lookup('Territory__c', 'Territory__c'),
          ],
          Contract: [idField, text('Name'), lookup('AccountId', 'Account', true)],
        };
        vi.mocked(deps.describeFields).mockImplementation(
          async (_org, object) => fields[object] ?? [idField],
        );
        vi.mocked(deps.queryRecords).mockImplementation(async (org, soql) => {
          const object = /\bFROM (\w+)/.exec(soql)?.[1] ?? '';
          return org === 'src' ? (tables[object] ?? []).map((row) => ({ ...row })) : [];
        });
        vi.mocked(deps.insertRecords).mockImplementation(async (_org, object, rows) =>
          rows.map((_, i) =>
            object === 'Account'
              ? { id: '', success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: refused'] }
              : { id: `${object}NEW${i}`, success: true, errors: [] },
          ),
        );
        deps.updateRecords = vi.fn<NonNullable<ForgeExecutorDeps['updateRecords']>>(
          async (_org, _object, rows) =>
            rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
        );
        const graph = makeGraph(
          [
            makeNode('Account', { recordCount: 1 }),
            makeNode('Contact', { recordCount: 1 }),
            makeNode('Contract', { recordCount: 1 }),
          ],
          [
            {
              sourceObject: 'Account',
              targetObject: 'Contact',
              relationshipName: 'Contacts',
              type: 'lookup',
            },
            {
              sourceObject: 'Account',
              targetObject: 'Contract',
              relationshipName: 'Contracts',
              type: 'lookup',
            },
          ],
        );

        const summary = await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', onProgress);
        const sent = (object: string): Array<Record<string, unknown>> =>
          vi
            .mocked(deps.insertRecords)
            .mock.calls.filter((call) => call[1] === object)
            .flatMap((call) => call[2]);
        return { summary, sent };
      }

      it('writes a child that can do without the parent, its lookup at it left empty and reported', async () => {
        // Skipped like any child of a failed parent, the contact was lost for
        // a lookup it may leave empty. Written with the source id kept, as a
        // run of whole tables keeps ids, it would name an account the target
        // never received.
        const { summary, sent } = await runWithAccountsRefused();

        expect(sent('Contact')).toHaveLength(1);
        expect(sent('Contact')[0]).not.toHaveProperty('AccountId');
        const pass2 = summary.errors.find((e) => e.objectApiName === '__pass2__');
        expect(pass2?.failedCount).toBe(1);
        expect(pass2?.samples[0].messages[0]).toContain("'AccountId'");
        expect(pass2?.samples[0].messages[0]).toContain(ACCOUNT);
      });

      it('still skips a child that cannot be written without the parent', async () => {
        const { summary, sent } = await runWithAccountsRefused();

        expect(sent('Contract')).toEqual([]);
        expect(summary.skippedCount).toBe(1);
        expect(
          progressEvents.find((e) => e.objectName === 'Contract' && e.status === 'skipped')
            ?.message,
        ).toContain('parent failed');
      });

      it('keeps the id a lookup gives of a parent that did not fail', async () => {
        const { sent } = await runWithAccountsRefused();

        expect(sent('Contact')[0]?.['Territory__c']).toBe(TERRITORY);
      });
    });

    it('counts the rows it read as failed when a node fails before any is written, not the count on the graph', async () => {
      // The graph's count is discovery's: zero on a template's graph, the
      // whole table for an object a scoped clone reads a few rows of.
      deps.anonymize = () => {
        throw new Error('The anonymizer stopped');
      };
      const graph = makeGraph([makeNode('Account', { recordCount: 50 })]);

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress, {
        anonymization: { fields: { Account: ['Name'] }, methods: {} },
      });

      expect(vi.mocked(deps.insertRecords)).not.toHaveBeenCalled();
      expect(summary.failedCount).toBe(2);
      expect(summary.errors).toEqual([
        {
          objectApiName: 'Account',
          stage: 'query',
          failedCount: 2,
          attemptedCount: 2,
          samples: [
            {
              recordSummary: '(stage failed before insert)',
              messages: ['The anonymizer stopped'],
            },
          ],
        },
      ]);
    });

    it('should handle thrown errors during query', async () => {
      vi.mocked(deps.queryRecords).mockRejectedValue(new Error('Connection lost'));

      const graph = makeGraph([makeNode('Account')]);
      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.failedCount).toBe(2); // node recordCount
      const errorEvent = progressEvents.find((e) => e.status === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.message).toContain('Connection lost');
    });
  });

  describe('progress events', () => {
    it('should emit scanning, running, and done events for a successful node', async () => {
      const graph = makeGraph([makeNode('Account')]);
      await executor.execute(graph, 'src', 'tgt', onProgress);

      const statuses = progressEvents.map((e) => e.status);
      expect(statuses).toContain('scanning');
      expect(statuses).toContain('running');
      expect(statuses).toContain('done');
    });

    it('should include object name in all progress events', async () => {
      const graph = makeGraph([makeNode('Account')]);
      await executor.execute(graph, 'src', 'tgt', onProgress);

      for (const event of progressEvents) {
        expect(event.objectName).toBe('Account');
      }
    });
  });

  describe('batching', () => {
    it('should batch inserts for large record sets', async () => {
      // Create 500 records
      const records = Array.from({ length: 500 }, (_, i) => ({
        Id: `001OLD${i}`,
        Name: `Record ${i}`,
      }));
      vi.mocked(deps.queryRecords).mockResolvedValue(records);
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objName, recs) => {
        return recs.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] }));
      });

      const graph = makeGraph([makeNode('Account', { recordCount: 500, batchStrategy: 'rest' })]);
      await executor.execute(graph, 'src', 'tgt', onProgress);

      // REST batch size is 200, so 500 records = ceil(500/200) = 3 batches
      expect(deps.insertRecords).toHaveBeenCalledTimes(3);

      // First batch should have 200 records
      const firstCall = vi.mocked(deps.insertRecords).mock.calls[0];
      expect(firstCall[2]).toHaveLength(200);

      // Last batch should have 100 records (500 - 200 - 200)
      const lastCall = vi.mocked(deps.insertRecords).mock.calls[2];
      expect(lastCall[2]).toHaveLength(100);
    });

    it('should emit progress for each batch', async () => {
      const records = Array.from({ length: 400 }, (_, i) => ({
        Id: `001OLD${i}`,
        Name: `Record ${i}`,
      }));
      vi.mocked(deps.queryRecords).mockResolvedValue(records);
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objName, recs) => {
        return recs.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] }));
      });

      const graph = makeGraph([makeNode('Account', { recordCount: 400, batchStrategy: 'rest' })]);
      await executor.execute(graph, 'src', 'tgt', onProgress);

      // Should have batch progress events with 'running' status
      const runningEvents = progressEvents.filter((e) => e.status === 'running');
      expect(runningEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('anonymization', () => {
    /** Contacts as the source holds them, with the fields a PII scan selects. */
    function contactsWithEmail(): void {
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false, type: 'id' },
        { name: 'LastName', queryable: true, createable: true, isReference: false, type: 'string' },
        { name: 'Email', queryable: true, createable: true, isReference: false, type: 'email' },
        { name: 'Phone', queryable: true, createable: true, isReference: false, type: 'phone' },
      ]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: '003OLD1', LastName: 'Source One', Email: 'one@source.test', Phone: '0102030405' },
        { Id: '003OLD2', LastName: 'Source Two', Email: 'two@source.test', Phone: '0607080910' },
      ]);
    }

    /** The rows the run sent to the target for its first insert. */
    function inserted(): Array<Record<string, unknown>> {
      return vi.mocked(deps.insertRecords).mock.calls[0][2];
    }

    it('anonymizes the fields selected on the node, each with the method of its category', async () => {
      contactsWithEmail();
      const graph = makeGraph([makeNode('Contact', { anonymizeFields: ['Email', 'Phone'] })]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        anonymization: {
          fields: { Contact: ['Email', 'Phone'] },
          methods: { email: 'fake', phone: 'redact' },
        },
      });

      const rows = inserted();
      // A fake address, and a different person for each record.
      expect(rows.map((r) => r['Email'])).not.toContain('one@source.test');
      expect(rows.map((r) => r['Email'])).not.toContain('two@source.test');
      expect(String(rows[0]['Email'])).toMatch(/^[a-z]+\.[a-z]+@example\.com$/);
      // The method Review chose for phones, not the default mask.
      expect(rows.map((r) => r['Phone'])).toEqual(['[REDACTED]', '[REDACTED]']);
      // A field nobody selected goes as the source holds it, and no row gains an Id.
      expect(rows.map((r) => r['LastName'])).toEqual(['Source One', 'Source Two']);
      expect(rows.every((r) => !('Id' in r))).toBe(true);
    });

    it('draws each record from a persona of its own, so the rows stay distinct people', async () => {
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false, type: 'id' },
        { name: 'Email', queryable: true, createable: true, isReference: false, type: 'email' },
      ]);
      const sourceRows = Array.from({ length: 40 }, (_, i) => ({
        Id: `003OLD${String(i).padStart(3, '0')}`,
        Email: `person${i}@source.test`,
      }));
      vi.mocked(deps.queryRecords).mockResolvedValue(sourceRows);
      vi.mocked(deps.insertRecords).mockImplementation(async (_org, _obj, recs) =>
        recs.map((_, i) => ({ id: `003NEW${i}`, success: true, errors: [] })),
      );
      const graph = makeGraph([makeNode('Contact', { recordCount: 40 })]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        anonymization: { fields: { Contact: ['Email'] }, methods: {} },
      });

      // A cleaned row has no Id: keyed by nothing, all forty were one person.
      const emails = new Set(inserted().map((r) => r['Email']));
      expect(emails.size).toBeGreaterThan(1);
    });

    it('anonymizes a renamed field under the name it is written by', async () => {
      contactsWithEmail();
      const graph = makeGraph([makeNode('Contact')]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        fieldMappings: { Contact: { Phone: 'MobilePhone' } },
        anonymization: { fields: { Contact: ['Phone'] }, methods: { phone: 'redact' } },
      });

      expect(inserted().map((r) => r['MobilePhone'])).toEqual(['[REDACTED]', '[REDACTED]']);
    });

    it('writes the source values when the run asks for no anonymization', async () => {
      contactsWithEmail();
      const graph = makeGraph([makeNode('Contact', { anonymizeFields: ['Email'] })]);

      await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(inserted().map((r) => r['Email'])).toEqual(['one@source.test', 'two@source.test']);
    });

    it('hands the rows, their source ids and the selected fields to an injected anonymizer', async () => {
      contactsWithEmail();
      const anonymize = vi.fn<NonNullable<ForgeExecutorDeps['anonymize']>>((request) =>
        request.records.map((r) => ({ ...r, Email: 'x@example.com' })),
      );
      const anonExecutor = new ForgeExecutor({ ...deps, anonymize });
      const graph = makeGraph([makeNode('Contact'), makeNode('Account')]);

      await anonExecutor.execute(graph, 'src', 'tgt', onProgress, {
        anonymization: { fields: { Contact: ['Email'] }, methods: { email: 'hash' } },
      });

      // Account has nothing selected: it is not handed over at all.
      expect(anonymize).toHaveBeenCalledTimes(1);
      expect(anonymize.mock.calls[0][0]).toMatchObject({
        objectApiName: 'Contact',
        sourceIds: ['003OLD1', '003OLD2'],
        fields: [{ name: 'Email', type: 'email' }],
        methods: { email: 'hash' },
      });
      expect(inserted().map((r) => r['Email'])).toEqual(['x@example.com', 'x@example.com']);
    });
  });

  describe('pause and resume', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('should support pause and resume', async () => {
      vi.useFakeTimers();
      const records = Array.from({ length: 400 }, (_, i) => ({
        Id: `001OLD${i}`,
        Name: `Record ${i}`,
      }));
      vi.mocked(deps.queryRecords).mockResolvedValue(records);
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objName, recs) => {
        return recs.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] }));
      });

      const graph = makeGraph([makeNode('Account', { recordCount: 400, batchStrategy: 'rest' })]);

      // Pause after first batch
      let batchCallCount = 0;
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objName, recs) => {
        batchCallCount++;
        if (batchCallCount === 1) {
          // Pause after first batch, then resume in next tick
          executor.pause();
          setTimeout(() => executor.resume(), 10);
        }
        return recs.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] }));
      });

      const running = executor.execute(graph, 'src', 'tgt', onProgress);
      // Settle the first batch so the run is parked on the pause.
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.insertRecords).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      const summary = await running;

      // Should complete all batches after resume
      expect(summary.successCount).toBe(400);
      expect(deps.insertRecords).toHaveBeenCalledTimes(2); // 200 + 200
    });

    it('should abort execution when abort is called', async () => {
      const records = Array.from({ length: 400 }, (_, i) => ({
        Id: `001OLD${i}`,
        Name: `Record ${i}`,
      }));
      vi.mocked(deps.queryRecords).mockResolvedValue(records);

      let batchCallCount = 0;
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objName, recs) => {
        batchCallCount++;
        if (batchCallCount === 1) {
          executor.abort();
        }
        return recs.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] }));
      });

      const graph = makeGraph([makeNode('Account', { recordCount: 400, batchStrategy: 'rest' })]);

      // Abort must stop the run, not be absorbed as a node-level failure.
      // The previous expectation — an 'error' progress event and a normal
      // return — was the bug: the per-node catch swallowed the abort and the
      // loop moved on to the next object, still writing to the target org.
      await expect(executor.execute(graph, 'src', 'tgt', onProgress)).rejects.toThrow(
        ForgeAbortedError,
      );

      // Nothing may be written after the user pressed Abort.
      expect(batchCallCount).toBe(1);
    });

    it('should stop before the next object when aborted mid-graph', async () => {
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: '001OLD1', Name: 'R1' }]);

      const written: string[] = [];
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objName, recs) => {
        written.push(objName);
        executor.abort();
        return recs.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] }));
      });

      const graph = makeGraph([
        makeNode('Account', { recordCount: 1, batchStrategy: 'rest' }),
        makeNode('Contact', { recordCount: 1, batchStrategy: 'rest' }),
      ]);

      await expect(executor.execute(graph, 'src', 'tgt', onProgress)).rejects.toThrow(
        ForgeAbortedError,
      );

      // The per-node abort guard is what stops the second object; without it
      // the loop advanced and Contact was written after the abort.
      expect(written).toEqual(['Account']);
    });

    it('keeps what an aborted run wrote with the error it throws', async () => {
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: '001OLD1', Name: 'R1' }]);
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objName, recs) => {
        executor.abort();
        return recs.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] }));
      });
      const graph = makeGraph([
        makeNode('Account', { recordCount: 1, batchStrategy: 'rest' }),
        makeNode('Contact', { recordCount: 1, batchStrategy: 'rest' }),
      ]);

      const error = await executor.execute(graph, 'src', 'tgt', onProgress).catch((e) => e);

      // The Account written before the abort is recorded with the run.
      expect(error).toBeInstanceOf(ForgeAbortedError);
      expect(partialSummaryOf(error)).toMatchObject({
        successCount: 1,
        remapByObject: [{ objectApiName: 'Account', created: 1, linked: 0 }],
      });
    });

    it('keeps what the first call of an object wrote when a cancel falls before its second', async () => {
      // 450 rows go out in three calls. The cancel lands during the first, so
      // the second call's checkpoint stops the node with 200 rows answered.
      const records = Array.from({ length: 450 }, (_, i) => ({
        Id: `001OLD${String(i).padStart(3, '0')}`,
        Name: `Record ${i}`,
      }));
      vi.mocked(deps.queryRecords).mockResolvedValue(records);
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objName, recs) => {
        executor.abort();
        return recs.map((_, i) =>
          i === 0
            ? { id: '', success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: refused'] }
            : { id: `001NEW${String(i).padStart(3, '0')}`, success: true, errors: [] },
        );
      });
      const graph = makeGraph([makeNode('Account', { recordCount: 450, batchStrategy: 'rest' })]);

      const error = await executor.execute(graph, 'src', 'tgt', onProgress).catch((e) => e);

      expect(error).toBeInstanceOf(ForgeAbortedError);
      expect(deps.insertRecords).toHaveBeenCalledTimes(1);
      const partial = partialSummaryOf(error);
      const created = records.slice(1, 200).map((r) => r.Id);
      expect(partial?.createdByObject).toEqual([{ objectApiName: 'Account', sourceIds: created }]);
      expect(Object.keys(partial?.remapTable ?? {})).toEqual(created);
      expect(partial?.successCount).toBe(199);
      expect(partial?.failedCount).toBe(1);
      expect(partial?.errors).toEqual([
        {
          objectApiName: 'Account',
          stage: 'insert',
          failedCount: 1,
          attemptedCount: 200,
          samples: [
            {
              recordSummary: 'Name=Record 0',
              messages: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: refused'],
            },
          ],
        },
      ]);
    });

    it('counts as failed a selling model refused as held and still waiting for its key when a cancel falls before the next call', async () => {
      // The target refused the first model without naming the one it holds:
      // the row waits for the lookup by its key made once the calls are
      // through, which the cancel before the second call never let come.
      deps.batchStrategy = {
        resolve: (_strategy, recordCount) => ({
          api: 'rest',
          batchSize: 1,
          batchCount: recordCount,
        }),
      };
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: '0jP000000000001', Name: 'One-time' },
        { Id: '0jP000000000002', Name: 'Monthly' },
      ]);
      const refusal =
        'DUPLICATE_VALUE: a product selling model already exists for this combination';
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objName, recs) => {
        executor.abort();
        return recs.map(() => ({ id: '', success: false, errors: [refusal] }));
      });
      const graph = makeGraph([makeNode('ProductSellingModel', { batchStrategy: 'rest' })]);

      const error = await executor.execute(graph, 'src', 'tgt', onProgress).catch((e) => e);

      expect(error).toBeInstanceOf(ForgeAbortedError);
      expect(deps.insertRecords).toHaveBeenCalledTimes(1);
      // Nothing is looked up in the target once the run is told to stop.
      expect(vi.mocked(deps.queryRecords).mock.calls.filter(([org]) => org === 'tgt')).toEqual([]);
      const partial = partialSummaryOf(error);
      expect(partial?.failedCount).toBe(1);
      expect(partial?.existingRecords).toEqual([
        { objectApiName: 'ProductSellingModel', linked: 0, unidentified: 1 },
      ]);
      expect(partial?.errors).toEqual([
        {
          objectApiName: 'ProductSellingModel',
          stage: 'insert',
          failedCount: 1,
          attemptedCount: 1,
          samples: [
            {
              recordSummary: 'Name=One-time',
              messages: [
                refusal,
                'The record the target holds under the same key was not looked up: ' +
                  'Forge execution was aborted by user request. No further batches will be processed.',
              ],
            },
          ],
        },
      ]);
    });
  });

  it('describes the target org while the source query is still running', async () => {
    // A full-table run writes each node as it reads it, so the target
    // describe is started alongside the query: one round-trip less of
    // waiting per object.
    const graph = makeGraph([makeNode('Case')]);
    let targetDescribedBeforeQueryReturned = false;
    vi.mocked(deps.queryRecords).mockImplementation(async () => {
      targetDescribedBeforeQueryReturned = vi
        .mocked(deps.describeFields)
        .mock.calls.some((c) => c[0] === 'tgt');
      return [{ Id: '500XX00000000001AAA', Name: 'X' }];
    });

    await executor.execute(graph, 'src', 'tgt', onProgress);

    expect(targetDescribedBeforeQueryReturned).toBe(true);
    expect(deps.insertRecords).toHaveBeenCalledTimes(1);
  });

  describe('record-scoped mode', () => {
    const ROOT_ID = '500XX00000000001AAA';

    it('should query the root with WHERE Id = ? when rootRecordId is provided', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, Subject: 'Test', AccountId: '001AAA' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Subject', queryable: true, createable: true, isReference: false },
        {
          name: 'AccountId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['Account'],
        },
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      expect(deps.queryRecords).toHaveBeenCalledWith(
        'src',
        `SELECT Id, Subject, AccountId FROM Case WHERE Id = '${ROOT_ID}'`,
        expect.any(Function),
      );
    });

    it('should skip nodes that are out of scope', async () => {
      const graph = makeGraph([makeNode('Case'), makeNode('Product2')], []);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID }]);

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      // Product2 has no path to Case via cache → should be skipped, not queried.
      expect(summary.skippedCount).toBeGreaterThanOrEqual(1);
      const product2Skipped = progressEvents.find(
        (e) => e.objectName === 'Product2' && e.status === 'skipped',
      );
      expect(product2Skipped?.message).toContain('out of scope');
    });

    it.each([false, true])(
      'counts an object no record of the clone reaches as skipped, never as an error (dry run: %s)',
      async (dryRun) => {
        // Nothing read points at a product and no product sits under anything
        // read: the clone holds none, and nothing is wrong. Listed among the
        // errors as 0 of 0, six such objects made up a real dry run's errors.
        const graph = makeGraph([makeNode('Case'), makeNode('Product2')], []);
        vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID }]);

        const summary = await executor.execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ROOT_ID,
          rootObjectApiName: 'Case',
          dryRun,
        });

        expect(summary.errors).toEqual([]);
        expect(summary.skippedCount).toBe(1);
      },
    );

    it('reads an ancestor whose ids only a descendant knows', async () => {
      // Entry is a parent of LineItem, so the execution order puts it before
      // the root's child — and at that point nothing has read a row that
      // points at it. Its turn comes again once LineItem has been read.
      const graph = makeGraph(
        [makeNode('Opportunity'), makeNode('Entry'), makeNode('LineItem')],
        [
          {
            sourceObject: 'Opportunity',
            targetObject: 'LineItem',
            relationshipName: 'LineItems',
            type: 'lookup',
          },
          {
            sourceObject: 'Entry',
            targetObject: 'LineItem',
            relationshipName: 'Entry',
            type: 'lookup',
          },
        ],
      );
      vi.mocked(deps.describeFields).mockImplementation(async (_org, objectApiName) => {
        if (objectApiName === 'LineItem') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            {
              name: 'OpportunityId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Opportunity'],
            },
            {
              name: 'EntryId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Entry'],
            },
          ];
        }
        return [{ name: 'Id', queryable: true, createable: false, isReference: false }];
      });
      vi.mocked(deps.queryRecords).mockImplementation(async (_org, soql) => {
        if (soql.includes('FROM LineItem')) {
          return [
            { Id: '00kXX0000000001AAA', OpportunityId: ROOT_ID, EntryId: '01uXX0000000001AAA' },
          ];
        }
        if (soql.includes('FROM Entry')) return [{ Id: '01uXX0000000001AAA' }];
        return [{ Id: ROOT_ID }];
      });

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Opportunity',
      });

      // Reads of the source: the target is read too, for its dates of the run.
      const entryQueries = vi
        .mocked(deps.queryRecords)
        .mock.calls.filter(([org, soql]) => org === 'src' && soql.includes('FROM Entry'));
      expect(entryQueries).toHaveLength(1);
      expect(entryQueries[0][1]).toContain("'01uXX0000000001AAA'");
      const entrySkipped = progressEvents.find(
        (e) => e.objectName === 'Entry' && e.status === 'skipped',
      );
      expect(entrySkipped).toBeUndefined();
      expect(summary.errors.find((e) => e.objectApiName === 'Entry')).toBeUndefined();
    });

    it('should propagate FK values from root to seed parent cache for multi-hop scope', async () => {
      const graph = makeGraph(
        [makeNode('Case'), makeNode('Account')],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Case',
            relationshipName: 'Account',
            type: 'lookup',
          },
        ],
      );
      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Case') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            {
              name: 'AccountId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Account'],
            },
          ];
        }
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'Name', queryable: true, createable: true, isReference: false },
        ];
      });
      vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) => {
        if (soql.includes('FROM Case')) {
          return [{ Id: ROOT_ID, AccountId: '001AAA' }];
        }
        if (soql.includes('FROM Account')) {
          return [{ Id: '001AAA', Name: 'Acme' }];
        }
        return [];
      });

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      const accountCall = vi
        .mocked(deps.queryRecords)
        .mock.calls.find((c) => c[1].includes('FROM Account'));
      expect(accountCall).toBeDefined();
      expect(accountCall![1]).toContain("Id IN ('001AAA')");
    });

    it('clones a child scoped by more than 600 parent ids, reading it in chunks', async () => {
      // 1,300 Contacts under the root Account used to stop the run: their
      // Tasks needed one IN list longer than a query URI holds.
      const ACCOUNT_ID = '001XX00000000001AAA';
      const contactIds = Array.from(
        { length: 1300 },
        (_, i) => `003${String(i).padStart(15, '0')}`,
      );
      const graph = makeGraph(
        [makeNode('Account'), makeNode('Contact'), makeNode('Task')],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
          {
            sourceObject: 'Contact',
            targetObject: 'Task',
            relationshipName: 'Tasks',
            type: 'lookup',
          },
        ],
      );
      const idField: FieldInfo = {
        name: 'Id',
        queryable: true,
        createable: false,
        isReference: false,
      };
      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Contact') {
          return [
            idField,
            {
              name: 'AccountId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Account'],
            },
          ];
        }
        if (name === 'Task') {
          return [
            idField,
            { name: 'Subject', queryable: true, createable: true, isReference: false },
            {
              name: 'WhoId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Contact'],
            },
          ];
        }
        return [idField, { name: 'Name', queryable: true, createable: true, isReference: false }];
      });
      let taskChunk = 0;
      vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) => {
        if (soql.includes('FROM Account')) return [{ Id: ACCOUNT_ID, Name: 'Acme' }];
        if (soql.includes('FROM Contact')) {
          return contactIds.map((Id) => ({ Id, AccountId: ACCOUNT_ID }));
        }
        taskChunk++;
        // The first Task matches Contacts from two chunks and comes back twice.
        return taskChunk === 1
          ? [{ Id: '00TXX0000000001AAA', Subject: 'Call', WhoId: contactIds[0] }]
          : [
              { Id: '00TXX0000000001AAA', Subject: 'Call', WhoId: contactIds[0] },
              { Id: `00TXX000000000${taskChunk}AAA`, Subject: 'Mail', WhoId: contactIds[1200] },
            ];
      });
      vi.mocked(deps.insertRecords).mockImplementation(async (_o, objectName, recs) =>
        recs.map((_, i) => ({ id: `${objectName}NEW${i}`, success: true, errors: [] })),
      );

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ACCOUNT_ID,
        rootObjectApiName: 'Account',
      });

      // Reads of the source: the target is read too, for its dates of the run.
      const taskQueries = vi
        .mocked(deps.queryRecords)
        .mock.calls.filter((c) => c[0] === 'src')
        .map((c) => c[1])
        .filter((soql) => soql.includes('FROM Task'));
      expect(taskQueries).toHaveLength(3);
      for (const soql of taskQueries) expect(encodeURIComponent(soql).length).toBeLessThan(16_000);
      expect(summary.errors.filter((e) => e.objectApiName === 'Task')).toEqual([]);
      const taskWrites = vi
        .mocked(deps.insertRecords)
        .mock.calls.filter((c) => c[1] === 'Task')
        .flatMap((c) => c[2]);
      expect(taskWrites.map((r) => r.Subject)).toEqual(['Call', 'Mail', 'Mail']);
    });

    it('does not describe the target org while it is still reading the source', async () => {
      // A scoped run reads every node before it writes any, so describing the
      // target alongside each query would fire the whole graph's describes at
      // an org that is not being written to yet. The describe moves to the
      // write pass, where it is needed.
      const graph = makeGraph([makeNode('Case')]);
      let targetDescribedDuringRead = false;
      vi.mocked(deps.queryRecords).mockImplementation(async (org) => {
        // The target is read once the run is written, for its dates of it.
        if (org !== 'src') return [];
        targetDescribedDuringRead = vi
          .mocked(deps.describeFields)
          .mock.calls.some((c) => c[0] === 'tgt');
        return [{ Id: ROOT_ID, Name: 'X' }];
      });

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      expect(targetDescribedDuringRead).toBe(false);
      // The describe still happens, and the record is still written.
      expect(vi.mocked(deps.describeFields).mock.calls.some((c) => c[0] === 'tgt')).toBe(true);
      expect(deps.insertRecords).toHaveBeenCalledTimes(1);
    });

    it('should bring the root to the front of topo order regardless of cycle bucketing', async () => {
      const graph = makeGraph(
        [makeNode('Case'), makeNode('Account')],
        // cycle: each references the other
        [
          {
            sourceObject: 'Account',
            targetObject: 'Case',
            relationshipName: 'Account',
            type: 'lookup',
          },
          {
            sourceObject: 'Case',
            targetObject: 'Account',
            relationshipName: 'Cases',
            type: 'lookup',
          },
        ],
      );
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID }]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      const queryCalls = vi.mocked(deps.queryRecords).mock.calls.map((c) => c[1]);
      const caseIndex = queryCalls.findIndex((s) => s.includes('FROM Case'));
      const accountIndex = queryCalls.findIndex((s) => s.includes('FROM Account'));
      expect(caseIndex).toBeGreaterThanOrEqual(0);
      expect(caseIndex).toBeLessThan(accountIndex >= 0 ? accountIndex : Infinity);
    });
  });

  describe('record-scoped mode, read from a fake source org', () => {
    const idField: FieldInfo = {
      name: 'Id',
      queryable: true,
      createable: false,
      isReference: false,
    };
    const text = (name: string): FieldInfo => ({
      name,
      queryable: true,
      createable: true,
      isReference: false,
    });
    const lookup = (name: string, target: string, required = false): FieldInfo => ({
      name,
      queryable: true,
      createable: true,
      isReference: true,
      referenceTo: [target],
      nillable: !required,
    });
    const edge = (sourceObject: string, targetObject: string): ForgeGraphEdge => ({
      sourceObject,
      targetObject,
      relationshipName: `${sourceObject}To${targetObject}`,
      type: 'lookup',
    });

    /**
     * A source org holding `tables`, and a target that names each record it
     * creates after the row's name: the contact named Key becomes
     * `Contact:Key`. What the target was sent is kept per object.
     */
    function fakeOrgs(tables: Record<string, FakeRow[]>, fields: Record<string, FieldInfo[]>) {
      const inserted: Record<string, Array<Record<string, unknown>>> = {};
      const updated: Array<{ object: string; rows: Array<Record<string, unknown>> }> = [];
      let unnamed = 0;
      const orgDeps: ForgeExecutorDeps = {
        describeFields: async (_org, object) => fields[object] ?? [idField],
        queryRecords: async (_org, soql) => selectRows(tables, soql),
        insertRecords: async (_org, object, rows) => {
          (inserted[object] ??= []).push(...rows);
          return rows.map((row) => ({
            id: `${object}:${String(row['Name'] ?? row['LastName'] ?? ++unnamed)}`,
            success: true,
            errors: [],
          }));
        },
        updateRecords: async (_org, object, rows) => {
          updated.push({ object, rows });
          return rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] }));
        },
      };
      return { orgDeps, inserted, updated };
    }

    /** The ids of the rows each object's reads returned, whatever the statement. */
    function recordReads(orgDeps: ForgeExecutorDeps): Record<string, Set<string>> {
      const read: Record<string, Set<string>> = {};
      const query = orgDeps.queryRecords;
      orgDeps.queryRecords = async (org, soql, onTruncated) => {
        const rows = await query(org, soql, onTruncated);
        const object = /\bFROM (\w+)/.exec(soql)?.[1] ?? '';
        for (const row of rows) (read[object] ??= new Set()).add(String(row['Id']));
        return rows;
      };
      return read;
    }

    const ACCOUNT = '001000000000001AAA';
    const KEY_CONTACT = '003000000000001AAA';
    const OTHER_CONTACT = '003000000000002AAA';
    const ELSEWHERE_ACCOUNT = '001000000000009AAA';
    const ELSEWHERE_CONTACT = '003000000000009AAA';

    /** A batch strategy that writes one record per call, so a node takes several. */
    const oneRecordPerCall: NonNullable<ForgeExecutorDeps['batchStrategy']> = {
      resolve: (_strategy, recordCount) => ({
        api: 'rest',
        batchSize: 1,
        batchCount: recordCount,
      }),
    };

    describe('an object several edges of the graph reach', () => {
      it('clones every contact of the root account, the key contact once, when the account names one', async () => {
        // Account carries a lookup to Contact, so Contact is a child of the root
        // account and a parent of it at once: a cycle. Run against a sandbox,
        // the clone took the contact the account named and dropped its sibling,
        // with no error — the rows the account pointed at were all Contact was
        // read for, and the relations followed the contacts that were read.
        const { orgDeps, inserted, updated } = fakeOrgs(
          {
            Account: [{ Id: ACCOUNT, Name: 'Root', Key_Contact__c: KEY_CONTACT }],
            Contact: [
              { Id: KEY_CONTACT, LastName: 'Key', AccountId: ACCOUNT },
              { Id: OTHER_CONTACT, LastName: 'Other', AccountId: ACCOUNT },
              { Id: ELSEWHERE_CONTACT, LastName: 'Elsewhere', AccountId: ELSEWHERE_ACCOUNT },
            ],
            AccountContactRelation: [
              { Id: '07k000000000001AAA', AccountId: ACCOUNT, ContactId: KEY_CONTACT },
              { Id: '07k000000000002AAA', AccountId: ACCOUNT, ContactId: OTHER_CONTACT },
              {
                Id: '07k000000000009AAA',
                AccountId: ELSEWHERE_ACCOUNT,
                ContactId: ELSEWHERE_CONTACT,
              },
            ],
          },
          {
            Account: [idField, text('Name'), lookup('Key_Contact__c', 'Contact')],
            Contact: [idField, text('LastName'), lookup('AccountId', 'Account')],
            AccountContactRelation: [
              idField,
              lookup('AccountId', 'Account', true),
              lookup('ContactId', 'Contact', true),
            ],
          },
        );
        // The graph discovery builds around an account at depth "direct".
        const graph = makeGraph(
          [makeNode('Account'), makeNode('Contact'), makeNode('AccountContactRelation')],
          [
            edge('Contact', 'Account'),
            edge('Account', 'AccountContactRelation'),
            edge('Account', 'Contact'),
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
        });

        expect(inserted['Contact'].map((r) => r['LastName'])).toEqual(['Key', 'Other']);
        expect(inserted['AccountContactRelation'].map((r) => r['ContactId'])).toEqual([
          'Contact:Key',
          'Contact:Other',
        ]);
        // The lookup that closes the cycle is written once its contact exists.
        expect(updated).toEqual([
          { object: 'Account', rows: [{ Id: 'Account:Root', Key_Contact__c: 'Contact:Key' }] },
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('reads the contact a root case names and the other contacts of the account it names', async () => {
        // No cycle: Contact is a parent of the root case and a child of the
        // case's account, two edges into the same object.
        const CASE = '500000000000001AAA';
        const CALLER = '003000000000003AAA';
        const { orgDeps, inserted } = fakeOrgs(
          {
            Case: [{ Id: CASE, Subject: 'Root', AccountId: ACCOUNT, ContactId: CALLER }],
            Account: [{ Id: ACCOUNT, Name: 'Customer' }],
            Contact: [
              { Id: KEY_CONTACT, LastName: 'Key', AccountId: ACCOUNT },
              { Id: OTHER_CONTACT, LastName: 'Other', AccountId: ACCOUNT },
              { Id: CALLER, LastName: 'Caller', AccountId: ELSEWHERE_ACCOUNT },
              { Id: ELSEWHERE_CONTACT, LastName: 'Elsewhere', AccountId: ELSEWHERE_ACCOUNT },
            ],
          },
          {
            Case: [
              idField,
              text('Subject'),
              lookup('AccountId', 'Account'),
              lookup('ContactId', 'Contact'),
            ],
            Account: [idField, text('Name')],
            Contact: [idField, text('LastName'), lookup('AccountId', 'Account')],
          },
        );
        const graph = makeGraph(
          [makeNode('Case'), makeNode('Account'), makeNode('Contact')],
          [edge('Account', 'Case'), edge('Contact', 'Case'), edge('Account', 'Contact')],
        );

        await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: CASE,
          rootObjectApiName: 'Case',
        });

        expect(inserted['Contact'].map((r) => r['LastName'])).toEqual(['Caller', 'Key', 'Other']);
      });

      it("leaves out the root account's parent and its contacts, which only a self-lookup names", async () => {
        // Discovery keeps no edge from an object to itself, so the account that
        // `ParentId` names is never read. Counted in scope all the same, it
        // would bring every contact under it, written with an account nothing
        // created.
        const PARENT_ACCOUNT = '001000000000002AAA';
        const { orgDeps, inserted, updated } = fakeOrgs(
          {
            Account: [
              { Id: ACCOUNT, Name: 'Root', ParentId: PARENT_ACCOUNT, Key_Contact__c: KEY_CONTACT },
              { Id: PARENT_ACCOUNT, Name: 'Group', ParentId: null, Key_Contact__c: null },
            ],
            Contact: [
              { Id: KEY_CONTACT, LastName: 'Key', AccountId: ACCOUNT, ReportsToId: null },
              {
                Id: OTHER_CONTACT,
                LastName: 'Other',
                AccountId: ACCOUNT,
                ReportsToId: KEY_CONTACT,
              },
              {
                Id: '003000000000008AAA',
                LastName: 'Head office',
                AccountId: PARENT_ACCOUNT,
                ReportsToId: null,
              },
            ],
          },
          {
            Account: [
              idField,
              text('Name'),
              lookup('ParentId', 'Account'),
              lookup('Key_Contact__c', 'Contact'),
            ],
            Contact: [
              idField,
              text('LastName'),
              lookup('AccountId', 'Account'),
              lookup('ReportsToId', 'Contact'),
            ],
          },
        );
        const graph = makeGraph(
          [makeNode('Account'), makeNode('Contact')],
          [edge('Contact', 'Account'), edge('Account', 'Contact')],
        );

        await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
        });

        expect(inserted['Account'].map((r) => r['Name'])).toEqual(['Root']);
        expect(inserted['Contact'].map((r) => r['LastName'])).toEqual(['Key', 'Other']);
        // The contacts' own self-lookup is written once both of them exist.
        expect(updated).toContainEqual({
          object: 'Contact',
          rows: [{ Id: 'Contact:Other', ReportsToId: 'Contact:Key' }],
        });
      });

      it('reads a contact that either of two account lookups names once, with the account’s others', async () => {
        const BILLING_CONTACT = '003000000000003AAA';
        const { orgDeps, inserted } = fakeOrgs(
          {
            Account: [
              {
                Id: ACCOUNT,
                Name: 'Root',
                Key_Contact__c: KEY_CONTACT,
                Billing_Contact__c: BILLING_CONTACT,
              },
            ],
            Contact: [
              { Id: KEY_CONTACT, LastName: 'Key', AccountId: ACCOUNT },
              { Id: OTHER_CONTACT, LastName: 'Other', AccountId: ACCOUNT },
              { Id: BILLING_CONTACT, LastName: 'Billing', AccountId: ELSEWHERE_ACCOUNT },
              { Id: ELSEWHERE_CONTACT, LastName: 'Elsewhere', AccountId: ELSEWHERE_ACCOUNT },
            ],
          },
          {
            Account: [
              idField,
              text('Name'),
              lookup('Key_Contact__c', 'Contact'),
              lookup('Billing_Contact__c', 'Contact'),
            ],
            Contact: [idField, text('LastName'), lookup('AccountId', 'Account')],
          },
        );
        const graph = makeGraph(
          [makeNode('Account'), makeNode('Contact')],
          [edge('Contact', 'Account'), edge('Account', 'Contact')],
        );

        await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
        });

        expect(inserted['Contact'].map((r) => r['LastName']).sort()).toEqual([
          'Billing',
          'Key',
          'Other',
        ]);
      });

      it('reads a contact through either of its two lookups to the root account', async () => {
        const MOVED_CONTACT = '003000000000004AAA';
        const { orgDeps, inserted } = fakeOrgs(
          {
            Account: [{ Id: ACCOUNT, Name: 'Root', Key_Contact__c: KEY_CONTACT }],
            Contact: [
              { Id: KEY_CONTACT, LastName: 'Key', AccountId: ACCOUNT, Previous_Account__c: null },
              {
                Id: MOVED_CONTACT,
                LastName: 'Moved',
                AccountId: ELSEWHERE_ACCOUNT,
                Previous_Account__c: ACCOUNT,
              },
              {
                Id: ELSEWHERE_CONTACT,
                LastName: 'Elsewhere',
                AccountId: ELSEWHERE_ACCOUNT,
                Previous_Account__c: null,
              },
            ],
          },
          {
            Account: [idField, text('Name'), lookup('Key_Contact__c', 'Contact')],
            Contact: [
              idField,
              text('LastName'),
              lookup('AccountId', 'Account'),
              lookup('Previous_Account__c', 'Account'),
            ],
          },
        );
        const graph = makeGraph(
          [makeNode('Account'), makeNode('Contact')],
          [edge('Contact', 'Account'), edge('Account', 'Contact')],
        );

        await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
        });

        expect(inserted['Contact'].map((r) => r['LastName'])).toEqual(['Key', 'Moved']);
      });
    });

    it('clones the relations of an account with 1,300 contacts, each holding both its parents', async () => {
      // A relation needs its account and its contact, both required: the read
      // held it to the 1,300 contacts in scope with one list in every
      // statement, longer than a query URI holds, and threw before reading any.
      const contacts = Array.from({ length: 1300 }, (_, i) => `003${String(i).padStart(15, '0')}`);
      const { orgDeps, inserted } = fakeOrgs(
        {
          Account: [{ Id: ACCOUNT, Name: 'Acme' }],
          Contact: contacts.map((Id, i) => ({ Id, LastName: `C${i}`, AccountId: ACCOUNT })),
          AccountContactRelation: [
            ...contacts.map((ContactId, i) => ({
              Id: `07k${String(i).padStart(15, '0')}`,
              Name: `R${i}`,
              AccountId: ACCOUNT,
              ContactId,
            })),
            // A relation of the account's first contact to another account.
            {
              Id: '07k999999999999999',
              Name: 'Elsewhere',
              AccountId: ELSEWHERE_ACCOUNT,
              ContactId: contacts[0],
            },
          ],
        },
        {
          Account: [idField, text('Name')],
          Contact: [idField, text('LastName'), lookup('AccountId', 'Account')],
          AccountContactRelation: [
            idField,
            text('Name'),
            lookup('AccountId', 'Account', true),
            lookup('ContactId', 'Contact', true),
          ],
        },
      );
      const graph = makeGraph(
        [makeNode('Account'), makeNode('Contact'), makeNode('AccountContactRelation')],
        [
          edge('Account', 'Contact'),
          { ...edge('Account', 'AccountContactRelation'), required: true },
          { ...edge('Contact', 'AccountContactRelation'), required: true },
        ],
      );

      const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ACCOUNT,
        rootObjectApiName: 'Account',
      });

      expect(summary.errors).toEqual([]);
      expect(inserted['AccountContactRelation']).toHaveLength(1300);
      expect(inserted['AccountContactRelation'].some((r) => r['Name'] === 'Elsewhere')).toBe(false);
    });

    it('keeps what a node wrote before one of its calls threw, and fills in the lookups those rows owe', async () => {
      // Thrown out of the node, the error made it fail whole: the contacts the
      // calls before had written were counted among the failed, their case
      // was skipped for want of them, and the lookup the first owed its case
      // never reached pass 2.
      const CASE = '500000000000001AAA';
      const { orgDeps, updated } = fakeOrgs(
        {
          Account: [{ Id: ACCOUNT, Name: 'Acme' }],
          Contact: [
            { Id: KEY_CONTACT, LastName: 'First', AccountId: ACCOUNT, Last_Case__c: CASE },
            { Id: OTHER_CONTACT, LastName: 'Second', AccountId: ACCOUNT, Last_Case__c: null },
            { Id: '003000000000003AAA', LastName: 'Third', AccountId: ACCOUNT, Last_Case__c: null },
          ],
          Case: [{ Id: CASE, Name: 'Help', ContactId: KEY_CONTACT }],
        },
        {
          Account: [idField, text('Name')],
          Contact: [
            idField,
            text('LastName'),
            lookup('AccountId', 'Account', true),
            lookup('Last_Case__c', 'Case'),
          ],
          Case: [idField, text('Name'), lookup('ContactId', 'Contact', true)],
        },
      );
      orgDeps.batchStrategy = oneRecordPerCall;
      const insert = orgDeps.insertRecords;
      orgDeps.insertRecords = async (org, object, rows) => {
        if (rows.some((row) => row['LastName'] === 'Third')) throw new Error('ECONNRESET');
        return insert(org, object, rows);
      };
      const graph = makeGraph(
        [makeNode('Account'), makeNode('Contact'), makeNode('Case')],
        [
          { ...edge('Account', 'Contact'), required: true },
          { ...edge('Contact', 'Case'), required: true },
          edge('Case', 'Contact'),
        ],
      );

      const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ACCOUNT,
        rootObjectApiName: 'Account',
      });

      expect(summary.successCount).toBe(4);
      expect(summary.failedCount).toBe(1);
      expect(summary.errors).toEqual([
        {
          objectApiName: 'Contact',
          stage: 'insert',
          failedCount: 1,
          attemptedCount: 3,
          samples: [
            { recordSummary: 'Contact batch 3/3: 1 record not written', messages: ['ECONNRESET'] },
          ],
        },
      ]);
      expect(updated).toEqual([
        { object: 'Contact', rows: [{ Id: 'Contact:First', Last_Case__c: 'Case:Help' }] },
      ]);
    });

    describe('an order past Draft', () => {
      const ORDER = '801000000000001AAA';
      const SECOND_ORDER = '801000000000002AAA';
      const ITEM = '802000000000001AAA';
      /** What a run that stopped says of each record it left a draft. */
      const LEFT_A_DRAFT =
        'Written as a draft, and the run stopped before giving it this status back: it stays a draft.';

      /**
       * An account with one activated order and its item, and a target that
       * refuses what the platform refuses: an order born past Draft — "for a
       * new or cloned order, choose Draft" — and an item under an order that
       * is not a draft.
       *
       * @param rows - Rows the source holds in place of, or besides, these.
       * @param orderFields - Fields of the order besides its name, account and status.
       * @param fields - Fields of the other objects the source holds.
       */
      function activatedOrder(
        rows: Record<string, FakeRow[]> = {},
        orderFields: FieldInfo[] = [],
        fields: Record<string, FieldInfo[]> = {},
      ) {
        const orgs = fakeOrgs(
          {
            Account: [{ Id: ACCOUNT, Name: 'Acme' }],
            Order: [{ Id: ORDER, Name: 'First', AccountId: ACCOUNT, Status: 'Live' }],
            OrderItem: [{ Id: ITEM, Name: 'Item', OrderId: ORDER }],
            ...rows,
          },
          {
            Account: [idField, text('Name')],
            Order: [
              idField,
              text('Name'),
              lookup('AccountId', 'Account', true),
              text('Status'),
              ...orderFields,
            ],
            OrderItem: [idField, text('Name'), lookup('OrderId', 'Order', true)],
            ...fields,
          },
        );
        const { orgDeps } = orgs;
        const query = orgDeps.queryRecords;
        orgDeps.queryRecords = async (org, soql, onTruncated) =>
          soql === 'SELECT ApiName, StatusCode FROM OrderStatus'
            ? [
                { ApiName: 'Open', StatusCode: 'Draft' },
                { ApiName: 'Live', StatusCode: 'Activated' },
              ]
            : query(org, soql, onTruncated);
        const statusOf = new Map<unknown, unknown>();
        const insert = orgDeps.insertRecords;
        orgDeps.insertRecords = async (org, object, rows) => {
          if (object === 'Order' && rows.some((r) => r['Status'] !== 'Open')) {
            return rows.map(() => ({
              id: '',
              success: false,
              errors: ['FAILED_ACTIVATION: for a new or cloned order, choose Draft'],
            }));
          }
          if (object === 'OrderItem' && rows.some((r) => statusOf.get(r['OrderId']) !== 'Open')) {
            return rows.map(() => ({
              id: '',
              success: false,
              errors: ['FIELD_INTEGRITY_EXCEPTION: unable to modify activated order'],
            }));
          }
          const results = await insert(org, object, rows);
          if (object === 'Order') rows.forEach((r, i) => statusOf.set(results[i].id, r['Status']));
          return results;
        };
        const graph = makeGraph(
          [makeNode('Account'), makeNode('Order'), makeNode('OrderItem')],
          [
            { ...edge('Account', 'Order'), required: true },
            { ...edge('Order', 'OrderItem'), required: true },
          ],
        );
        return { ...orgs, graph };
      }

      it('writes an activated order as a draft, its item under it, then activates it again', async () => {
        const { orgDeps, inserted, updated, graph } = activatedOrder();

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
        });

        expect(inserted['Order']).toEqual([
          { Name: 'First', AccountId: 'Account:Acme', Status: 'Open' },
        ]);
        expect(inserted['OrderItem']).toEqual([{ Name: 'Item', OrderId: 'Order:First' }]);
        expect(updated).toEqual([
          { object: 'Order', rows: [{ Id: 'Order:First', Status: 'Live' }] },
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('says which order the target would not take back past Draft, and leaves it a draft', async () => {
        const { orgDeps, inserted, graph } = activatedOrder();
        orgDeps.updateRecords = async (_org, _object, rows) =>
          rows.map((row) => ({
            id: String(row['Id']),
            success: false,
            errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: an order needs a billing address'],
          }));

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
        });

        expect(inserted['OrderItem']).toHaveLength(1);
        expect(summary.errors).toEqual([
          {
            objectApiName: 'Order',
            stage: 'insert',
            failedCount: 1,
            attemptedCount: 1,
            samples: [
              {
                recordSummary: 'Order Order:First Status=Live',
                messages: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: an order needs a billing address'],
              },
            ],
          },
        ]);
      });

      it('gives an order an upsert wrote over through its external id its status back', async () => {
        // Only the target decides whether an upsert creates or writes over, so
        // the order it matched went over as a draft like any other. Left out of
        // the restore as a record the target already held, an order activated
        // there was turned back into a draft by the run, and nothing said so.
        const { orgDeps, inserted, updated, graph } = activatedOrder(
          {
            Order: [
              {
                Id: ORDER,
                Name: 'First',
                AccountId: ACCOUNT,
                Status: 'Live',
                Ext__c: 'order-first',
              },
            ],
          },
          [{ ...text('Ext__c'), externalId: true }],
        );
        const insert = orgDeps.insertRecords;
        orgDeps.upsertRecords = async (org, object, _field, rows) =>
          (await insert(org, object, rows)).map((result) => ({ ...result, created: false }));

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
          upsertMode: 'auto',
        });

        expect(inserted['Order']).toEqual([
          { Name: 'First', AccountId: 'Account:Acme', Status: 'Open', Ext__c: 'order-first' },
        ]);
        expect(summary.updatedCount).toBe(1);
        expect(updated).toEqual([
          { object: 'Order', rows: [{ Id: 'Order:First', Status: 'Live' }] },
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('gives an order written before a later call of its node threw its status back', async () => {
        // The statuses owed were only noted once every call of the node had
        // answered: a call that threw took the node down before that, and the
        // orders the calls before it had written stayed drafts, unreported.
        const { orgDeps, updated, graph } = activatedOrder({
          Order: [
            { Id: ORDER, Name: 'First', AccountId: ACCOUNT, Status: 'Live' },
            { Id: SECOND_ORDER, Name: 'Second', AccountId: ACCOUNT, Status: 'Live' },
          ],
        });
        orgDeps.batchStrategy = oneRecordPerCall;
        const insert = orgDeps.insertRecords;
        orgDeps.insertRecords = async (org, object, rows) => {
          if (rows.some((row) => row['Name'] === 'Second')) throw new Error('ECONNRESET');
          return insert(org, object, rows);
        };

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
        });

        // One order of two written is a node half written, not a failed one:
        // the item of the order written goes in under it, still a draft.
        expect(summary.createdByObject).toEqual([
          { objectApiName: 'Account', sourceIds: [ACCOUNT] },
          { objectApiName: 'Order', sourceIds: [ORDER] },
          { objectApiName: 'OrderItem', sourceIds: [ITEM] },
        ]);
        expect(updated).toEqual([
          { object: 'Order', rows: [{ Id: 'Order:First', Status: 'Live' }] },
        ]);
      });

      it('says which orders a run cancelled while writing their items left as drafts, and writes nothing more', async () => {
        const { orgDeps, inserted, updated, graph } = activatedOrder({
          OrderItem: [
            { Id: ITEM, Name: 'Item', OrderId: ORDER },
            { Id: '802000000000002AAA', Name: 'Other item', OrderId: ORDER },
          ],
        });
        orgDeps.batchStrategy = oneRecordPerCall;
        const executor = new ForgeExecutor(orgDeps);
        const insert = orgDeps.insertRecords;
        orgDeps.insertRecords = async (org, object, rows) => {
          // Cancelled while the first item is written: the second never is.
          if (object === 'OrderItem') executor.abort();
          return insert(org, object, rows);
        };

        const error = await executor
          .execute(graph, 'src', 'tgt', onProgress, {
            rootRecordId: ACCOUNT,
            rootObjectApiName: 'Account',
          })
          .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ForgeAbortedError);
        expect(inserted['OrderItem']).toEqual([{ Name: 'Item', OrderId: 'Order:First' }]);
        // A cancel writes nothing more: the order stays the draft it went in as.
        expect(updated).toEqual([]);
        expect(partialSummaryOf(error)?.errors).toEqual([
          {
            objectApiName: 'Order',
            stage: 'insert',
            failedCount: 1,
            attemptedCount: 1,
            samples: [{ recordSummary: 'Order Order:First Status=Live', messages: [LEFT_A_DRAFT] }],
          },
        ]);
      });

      it('says which orders a run cancelled while copying their files left as drafts', async () => {
        // The files go after the records and before the statuses, and their
        // copy stops on a cancel before each file.
        const { orgDeps, updated, graph } = activatedOrder();
        const query = orgDeps.queryRecords;
        orgDeps.queryRecords = async (org, soql, onTruncated) =>
          org === 'src' && soql.includes(' FROM Attachment ')
            ? ['00P000000000001AAA', '00P000000000002AAA'].map((Id, i) => ({
                Id,
                ParentId: ORDER,
                Name: `note${i + 1}.txt`,
                ContentType: 'text/plain',
                BodyLength: 3,
                IsPrivate: false,
              }))
            : query(org, soql, onTruncated);
        const executor = new ForgeExecutor(orgDeps);
        orgDeps.readFileBody = async () => Buffer.from('abc').toString('base64');
        orgDeps.insertFile = async () => {
          // Cancelled while the first file is written: the second never is.
          executor.abort();
          return { id: '00P000000000501AAA', success: true, errors: [] };
        };
        orgDeps.remainingFileStorageMB = async () => 100;

        const error = await executor
          .execute(graph, 'src', 'tgt', onProgress, {
            rootRecordId: ACCOUNT,
            rootObjectApiName: 'Account',
            files: { maxFileBytes: 1_000 },
          })
          .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ForgeAbortedError);
        expect(partialSummaryOf(error)?.files?.objects).toEqual([
          { objectApiName: 'Attachment', planned: 2, plannedBytes: 6, copied: 1, failed: 0 },
        ]);
        expect(updated).toEqual([]);
        expect(partialSummaryOf(error)?.errors).toEqual([
          {
            objectApiName: 'Order',
            stage: 'insert',
            failedCount: 1,
            attemptedCount: 1,
            samples: [{ recordSummary: 'Order Order:First Status=Live', messages: [LEFT_A_DRAFT] }],
          },
        ]);
      });

      describe('whose items discovery never reached', () => {
        const DRAFT_ORDER = '801000000000003AAA';
        const DRAFT_ITEM = '802000000000003AAA';
        /** What the target answers an order activated with nothing on it. */
        const NO_PRODUCT = 'FAILED_ACTIVATION: an order must include at least one product';

        /**
         * The graph the default cap left around an account: its orders and
         * none of their items. The source holds an activated order with an
         * item and a draft with another, and the target activates no order
         * without an item on it, as the platform does not.
         */
        function capped({
          firstStatus = 'Live',
          graphNodes = [],
        }: { firstStatus?: string; graphNodes?: ForgeGraphNode[] } = {}) {
          const run = activatedOrder({
            Order: [
              { Id: ORDER, Name: 'First', AccountId: ACCOUNT, Status: firstStatus },
              { Id: DRAFT_ORDER, Name: 'Pending', AccountId: ACCOUNT, Status: 'Open' },
            ],
            OrderItem: [
              { Id: ITEM, Name: 'Item', OrderId: ORDER },
              { Id: DRAFT_ITEM, Name: 'Pending item', OrderId: DRAFT_ORDER },
            ],
          });
          const { orgDeps, inserted } = run;
          const update = orgDeps.updateRecords;
          if (!update) throw new Error('the fake org updates');
          orgDeps.updateRecords = async (org, object, rows) =>
            (await update(org, object, rows)).map((result, i) =>
              object === 'Order' &&
              !(inserted['OrderItem'] ?? []).some((item) => item['OrderId'] === rows[i]['Id'])
                ? { ...result, success: false, errors: [NO_PRODUCT] }
                : result,
            );
          const graph = makeGraph(
            [makeNode('Account'), makeNode('Order'), ...graphNodes],
            [{ ...edge('Account', 'Order'), required: true }],
          );
          return { ...run, graph };
        }
        const rooted = { rootRecordId: ACCOUNT, rootObjectApiName: 'Account' };

        it('activates an order past Draft with the items the cap left out, and them alone', async () => {
          // Run for real at the default cap, discovery reached an
          // opportunity's orders and not their items: the two activated
          // orders went in as drafts and the target refused them their
          // status back — "an order must include at least one product".
          const { orgDeps, inserted, updated, graph } = capped();

          const summary = await new ForgeExecutor(orgDeps).execute(
            graph,
            'src',
            'tgt',
            onProgress,
            rooted,
          );

          expect(inserted['OrderItem']).toEqual([{ Name: 'Item', OrderId: 'Order:First' }]);
          expect(updated).toEqual([
            { object: 'Order', rows: [{ Id: 'Order:First', Status: 'Live' }] },
          ]);
          // A draft goes in as it is and needs no item: the cap left its
          // items out, and out they stay.
          expect(summary.readByObject).toContainEqual({ objectApiName: 'OrderItem', read: 1 });
          expect(summary.errors).toEqual([]);
        });

        it('says in a dry run the items a real run writes for the orders it activates', async () => {
          const { orgDeps, inserted, graph } = capped();

          const summary = await new ForgeExecutor(orgDeps).execute(
            graph,
            'src',
            'tgt',
            onProgress,
            { ...rooted, dryRun: true },
          );

          expect(inserted).toEqual({});
          expect(progressEvents.map((e) => e.message)).toContain(
            '[dry-run] OrderItem: 1 record(s) would be inserted',
          );
          expect(summary.wouldInsertCount).toBe(4);
          expect(summary.errors).toEqual([]);
        });

        it('leaves out the items of a graph that holds them and leaves them out', async () => {
          // Unchecked, or empty in the whole org: the restore says what it
          // could not give back.
          const { orgDeps, inserted, graph } = capped({
            graphNodes: [makeNode('OrderItem', { included: false })],
          });
          const read = recordReads(orgDeps);

          const summary = await new ForgeExecutor(orgDeps).execute(
            graph,
            'src',
            'tgt',
            onProgress,
            rooted,
          );

          expect(read['OrderItem']).toBeUndefined();
          expect(inserted['OrderItem']).toBeUndefined();
          expect(summary.errors).toEqual([
            expect.objectContaining({
              objectApiName: 'Order',
              failedCount: 1,
              samples: [{ recordSummary: 'Order Order:First Status=Live', messages: [NO_PRODUCT] }],
            }),
          ]);
        });

        it('brings no item when no order it reads is past Draft', async () => {
          const { orgDeps, inserted, updated, graph } = capped({ firstStatus: 'Open' });

          const summary = await new ForgeExecutor(orgDeps).execute(
            graph,
            'src',
            'tgt',
            onProgress,
            rooted,
          );

          expect(inserted['Order']).toHaveLength(2);
          expect(inserted['OrderItem'] ?? []).toEqual([]);
          expect(summary.readByObject).toContainEqual({ objectApiName: 'OrderItem', read: 0 });
          expect(updated).toEqual([]);
          expect(summary.errors).toEqual([]);
        });
      });

      describe('fetched as the parent of a record the run writes', () => {
        const DELIVERY = 'a01000000000001AAA';

        /**
         * A delivery of the account that cannot be written without its order,
         * an order the graph does not reach: copied as an orphan parent, it
         * went over activated and was refused, and the delivery with it.
         */
        function deliveries(rows: FakeRow[]) {
          const orgs = activatedOrder({ Delivery__c: rows }, [], {
            Delivery__c: [
              idField,
              text('Name'),
              lookup('Account__c', 'Account'),
              lookup('Order__c', 'Order', true),
            ],
          });
          const graph = makeGraph(
            [makeNode('Account'), makeNode('Delivery__c')],
            [edge('Account', 'Delivery__c')],
          );
          return { ...orgs, graph };
        }

        it('writes it as a draft, and gives it its status back with the orders the run cloned', async () => {
          const { orgDeps, inserted, updated, graph } = deliveries([
            { Id: DELIVERY, Name: 'Truck', Account__c: ACCOUNT, Order__c: ORDER },
          ]);

          const summary = await new ForgeExecutor(orgDeps).execute(
            graph,
            'src',
            'tgt',
            onProgress,
            { rootRecordId: ACCOUNT, rootObjectApiName: 'Account', expandOrphanParents: true },
          );

          expect(inserted['Order']).toEqual([{ Name: 'First', Status: 'Open' }]);
          expect(inserted['Delivery__c']).toEqual([
            { Name: 'Truck', Account__c: 'Account:Acme', Order__c: 'Order:First' },
          ]);
          expect(updated).toEqual([
            { object: 'Order', rows: [{ Id: 'Order:First', Status: 'Live' }] },
          ]);
          expect(summary.errors).toEqual([]);
        });

        it('says so when a cancelled run leaves it a draft', async () => {
          const { orgDeps, updated, graph } = deliveries([
            { Id: DELIVERY, Name: 'Truck', Account__c: ACCOUNT, Order__c: ORDER },
            { Id: 'a01000000000002AAA', Name: 'Van', Account__c: ACCOUNT, Order__c: ORDER },
          ]);
          orgDeps.batchStrategy = oneRecordPerCall;
          const executor = new ForgeExecutor(orgDeps);
          const insert = orgDeps.insertRecords;
          orgDeps.insertRecords = async (org, object, rows) => {
            // Cancelled while the first delivery is written: the second never is.
            if (object === 'Delivery__c') executor.abort();
            return insert(org, object, rows);
          };

          const error = await executor
            .execute(graph, 'src', 'tgt', onProgress, {
              rootRecordId: ACCOUNT,
              rootObjectApiName: 'Account',
              expandOrphanParents: true,
            })
            .catch((err: unknown) => err);

          expect(error).toBeInstanceOf(ForgeAbortedError);
          expect(updated).toEqual([]);
          expect(partialSummaryOf(error)?.errors).toEqual([
            {
              objectApiName: 'Order',
              stage: 'insert',
              failedCount: 1,
              attemptedCount: 1,
              samples: [
                { recordSummary: 'Order Order:First Status=Live', messages: [LEFT_A_DRAFT] },
              ],
            },
          ]);
        });
      });
    });

    it('writes a root opportunity after its account, instead of patching the account in afterwards', async () => {
      // A line of the opportunity has a required lookup, so the order is
      // settled on required edges — and the opportunity, met first, was
      // written first with its account left out and patched by pass 2.
      const OPPORTUNITY = '006000000000001AAA';
      const { orgDeps, inserted, updated } = fakeOrgs(
        {
          Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal', AccountId: ACCOUNT }],
          Account: [{ Id: ACCOUNT, Name: 'Acme' }],
          OpportunityContactRole: [
            { Id: '00K000000000001AAA', Name: 'Buyer', OpportunityId: OPPORTUNITY },
          ],
        },
        {
          Opportunity: [idField, text('Name'), lookup('AccountId', 'Account')],
          Account: [idField, text('Name')],
          OpportunityContactRole: [
            idField,
            text('Name'),
            lookup('OpportunityId', 'Opportunity', true),
          ],
        },
      );
      const graph = makeGraph(
        [makeNode('Opportunity'), makeNode('Account'), makeNode('OpportunityContactRole')],
        [
          edge('Account', 'Opportunity'),
          { ...edge('Opportunity', 'OpportunityContactRole'), required: true },
        ],
      );

      const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: OPPORTUNITY,
        rootObjectApiName: 'Opportunity',
      });

      expect(Object.keys(inserted)).toEqual(['Account', 'Opportunity', 'OpportunityContactRole']);
      expect(inserted['Opportunity']).toEqual([{ Name: 'Deal', AccountId: 'Account:Acme' }]);
      expect(updated).toEqual([]);
      expect(summary.errors).toEqual([]);
    });

    it('writes a line after the opportunity it requires, where the graph lost that the lookup is required', async () => {
      // Discovery keeps one edge per pair of objects, and the one it met first
      // — the opportunity's list of its line items — says nothing of a
      // required lookup. The opportunity and the quote synced to it point at
      // each other, as do it and a contract: it always had a parent still to
      // write, its line never did, and parents first put the line first.
      const OPPORTUNITY = '006000000000001AAA';
      const QUOTE = '0Q0000000000001AAA';
      const CONTRACT = 'a0C000000000001AAA';
      const { orgDeps, inserted } = fakeOrgs(
        {
          Opportunity: [
            { Id: OPPORTUNITY, Name: 'Deal', SyncedQuoteId: QUOTE, Contract__c: CONTRACT },
          ],
          Quote: [{ Id: QUOTE, Name: 'Offer', OpportunityId: OPPORTUNITY }],
          Contract__c: [{ Id: CONTRACT, Name: 'Frame', Opportunity__c: OPPORTUNITY }],
          OpportunityLineItem: [
            { Id: '00k000000000001AAA', Name: 'Line', OpportunityId: OPPORTUNITY },
          ],
          OpportunityContactRole: [
            { Id: '00K000000000001AAA', Name: 'Buyer', OpportunityId: OPPORTUNITY },
          ],
        },
        {
          Opportunity: [
            idField,
            text('Name'),
            lookup('SyncedQuoteId', 'Quote'),
            lookup('Contract__c', 'Contract__c'),
          ],
          Quote: [idField, text('Name'), lookup('OpportunityId', 'Opportunity')],
          Contract__c: [idField, text('Name'), lookup('Opportunity__c', 'Opportunity')],
          OpportunityLineItem: [
            idField,
            text('Name'),
            lookup('OpportunityId', 'Opportunity', true),
          ],
          OpportunityContactRole: [
            idField,
            text('Name'),
            lookup('OpportunityId', 'Opportunity', true),
          ],
        },
      );
      const insert = orgDeps.insertRecords;
      orgDeps.insertRecords = async (org, object, rows) => {
        // As the platform does: no line without its opportunity.
        if (object === 'OpportunityLineItem' && rows.some((r) => !r['OpportunityId'])) {
          return rows.map(() => ({
            id: '',
            success: false,
            errors: ['REQUIRED_FIELD_MISSING: Required fields are missing: [OpportunityId]'],
          }));
        }
        return insert(org, object, rows);
      };
      // In the order discovery met them: the line before the quote and the
      // contract, one level down from the opportunity.
      const graph = makeGraph(
        [
          makeNode('Opportunity'),
          makeNode('OpportunityLineItem'),
          makeNode('Quote'),
          makeNode('Contract__c'),
          makeNode('OpportunityContactRole'),
        ],
        [
          edge('Quote', 'Opportunity'),
          edge('Opportunity', 'Quote'),
          edge('Contract__c', 'Opportunity'),
          edge('Opportunity', 'Contract__c'),
          edge('Opportunity', 'OpportunityLineItem'),
          { ...edge('Opportunity', 'OpportunityContactRole'), required: true },
        ],
      );

      const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: OPPORTUNITY,
        rootObjectApiName: 'Opportunity',
      });

      const written = Object.keys(inserted);
      expect(written.indexOf('Opportunity')).toBeLessThan(written.indexOf('OpportunityLineItem'));
      expect(inserted['OpportunityLineItem']).toEqual([
        { Name: 'Line', OpportunityId: 'Opportunity:Deal' },
      ]);
      expect(summary.errors).toEqual([]);
    });

    it('writes a root opportunity and its lines when the quote synced to it is held back', async () => {
      // As a real org has it: the running user cannot use the quotes' record
      // types in the target, so every quote is held back. Parents first, the
      // quote now goes before the opportunity that points at it; a failed
      // parent, required or not, took the opportunity down with it, and every
      // line behind the opportunity.
      const OPPORTUNITY = '006000000000001AAA';
      const QUOTE = '0Q0000000000001AAA';
      const CONTRACT = 'a0C000000000001AAA';
      const OFFER = '012000000000001AAA';
      const { orgDeps, inserted } = fakeOrgs(
        {
          Opportunity: [
            { Id: OPPORTUNITY, Name: 'Deal', SyncedQuoteId: QUOTE, Contract__c: CONTRACT },
          ],
          Quote: [{ Id: QUOTE, Name: 'Offer', OpportunityId: OPPORTUNITY, RecordTypeId: OFFER }],
          Contract__c: [{ Id: CONTRACT, Name: 'Frame', Opportunity__c: OPPORTUNITY }],
          OpportunityLineItem: [
            { Id: '00k000000000001AAA', Name: 'Line', OpportunityId: OPPORTUNITY },
          ],
        },
        {
          Opportunity: [
            idField,
            text('Name'),
            lookup('SyncedQuoteId', 'Quote'),
            lookup('Contract__c', 'Contract__c'),
          ],
          Quote: [
            idField,
            text('Name'),
            lookup('OpportunityId', 'Opportunity'),
            lookup('RecordTypeId', 'RecordType'),
          ],
          Contract__c: [idField, text('Name'), lookup('Opportunity__c', 'Opportunity')],
          OpportunityLineItem: [
            idField,
            text('Name'),
            lookup('OpportunityId', 'Opportunity', true),
          ],
        },
      );
      orgDeps.describeObject = async (_org, object) => ({
        keyPrefix: null,
        recordTypes:
          object === 'Quote'
            ? [
                {
                  recordTypeId: OFFER,
                  developerName: 'Offer',
                  name: 'Offer',
                  available: false,
                  active: true,
                  master: false,
                  defaultRecordTypeMapping: false,
                },
              ]
            : [],
      });
      const graph = makeGraph(
        [
          makeNode('Opportunity'),
          makeNode('Quote'),
          makeNode('Contract__c'),
          makeNode('OpportunityLineItem'),
        ],
        [
          edge('Quote', 'Opportunity'),
          edge('Opportunity', 'Quote'),
          edge('Contract__c', 'Opportunity'),
          edge('Opportunity', 'Contract__c'),
          { ...edge('Opportunity', 'OpportunityLineItem'), required: true },
        ],
      );

      const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: OPPORTUNITY,
        rootObjectApiName: 'Opportunity',
      });

      expect(inserted['Quote']).toBeUndefined();
      expect(inserted['Opportunity'].map((r) => r['Name'])).toEqual(['Deal']);
      expect(inserted['Contract__c'].map((r) => r['Name'])).toEqual(['Frame']);
      expect(inserted['OpportunityLineItem']).toEqual([
        { Name: 'Line', OpportunityId: 'Opportunity:Deal' },
      ]);
      // The quote is reported as held back, and the lookup at it as one the
      // second pass could not fill in.
      expect(summary.errors.map((e) => [e.objectApiName, e.stage])).toEqual([
        ['Quote', 'scope'],
        ['__pass2__', 'insert'],
      ]);
      expect(summary.errors[1].samples[0].messages[0]).toContain("'SyncedQuoteId'");
    });

    describe('a parent whose turn comes after its child', () => {
      const OPPORTUNITY = '006000000000001AAA';
      const FIRST_ORDER = '801000000000001AAA';
      const SECOND_ORDER = '801000000000002AAA';
      const ELSEWHERE_ORDER = '801000000000009AAA';

      /**
       * An opportunity with two orders, each with its action, and the graph
       * discovery leaves them in: the opportunity names one of its orders, so
       * the two sit in a cycle, and the actions come before the orders.
       */
      function ordersOfAnOpportunity() {
        const { orgDeps, inserted } = fakeOrgs(
          {
            Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal', Last_Order__c: FIRST_ORDER }],
            Order: [
              { Id: FIRST_ORDER, Name: 'First', OpportunityId: OPPORTUNITY },
              { Id: SECOND_ORDER, Name: 'Second', OpportunityId: OPPORTUNITY },
              { Id: ELSEWHERE_ORDER, Name: 'Elsewhere', OpportunityId: '006000000000009AAA' },
            ],
            OrderAction: [
              { Id: '8OA000000000001AAA', Name: 'Add first', OrderId: FIRST_ORDER },
              { Id: '8OA000000000002AAA', Name: 'Add second', OrderId: SECOND_ORDER },
              { Id: '8OA000000000009AAA', Name: 'Add elsewhere', OrderId: ELSEWHERE_ORDER },
            ],
          },
          {
            Opportunity: [idField, text('Name'), lookup('Last_Order__c', 'Order')],
            Order: [idField, text('Name'), lookup('OpportunityId', 'Opportunity')],
            OrderAction: [idField, text('Name'), lookup('OrderId', 'Order', true)],
          },
        );
        const graph = makeGraph(
          [makeNode('Opportunity'), makeNode('OrderAction'), makeNode('Order')],
          [
            edge('Opportunity', 'Order'),
            edge('Order', 'Opportunity'),
            { ...edge('Order', 'OrderAction'), required: true },
          ],
        );
        return { orgDeps, inserted, graph };
      }

      it('reads the action of every order of the opportunity, after the orders', async () => {
        // Read at its turn, the action was held to the orders met so far —
        // the one the opportunity names — and not to the orders under it.
        // Run for real, the orders met so far were an opportunity's id and a
        // quote's, put in scope as orders by lookups that can name nearly
        // any object: none of the eleven actions came with the clone.
        const { orgDeps, inserted, graph } = ordersOfAnOpportunity();
        const read = recordReads(orgDeps);

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: OPPORTUNITY,
          rootObjectApiName: 'Opportunity',
        });

        expect([...(read['OrderAction'] ?? [])].sort()).toEqual([
          '8OA000000000001AAA',
          '8OA000000000002AAA',
        ]);
        expect(inserted['Order'].map((r) => r['Name'])).toEqual(['First', 'Second']);
        expect(inserted['OrderAction'].map((r) => r['OrderId'])).toEqual([
          'Order:First',
          'Order:Second',
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('reads the root first, whatever parent it cannot be written without', async () => {
        // Every scope starts from the root. Held back until its account's
        // turn, the account was read by the ids named before the root was
        // read — a contact's — and the root's own account was never read.
        const ROOT_ACCOUNT = '001000000000001AAA';
        const OTHER_ACCOUNT = '001000000000002AAA';
        const { orgDeps, inserted } = fakeOrgs(
          {
            Order: [{ Id: FIRST_ORDER, Name: 'Root order', AccountId: ROOT_ACCOUNT }],
            Contact: [
              {
                Id: '003000000000001AAA',
                LastName: 'Buyer',
                Last_Order__c: FIRST_ORDER,
                AccountId: OTHER_ACCOUNT,
              },
            ],
            Account: [
              { Id: ROOT_ACCOUNT, Name: 'Root account' },
              { Id: OTHER_ACCOUNT, Name: 'Other account' },
            ],
          },
          {
            Order: [idField, text('Name'), lookup('AccountId', 'Account', true)],
            Contact: [
              idField,
              text('LastName'),
              lookup('Last_Order__c', 'Order'),
              lookup('AccountId', 'Account'),
            ],
            Account: [idField, text('Name'), lookup('Primary_Contact__c', 'Contact')],
          },
        );
        // A cycle through all three: the order the graph lists them in stands.
        const graph = makeGraph(
          [makeNode('Order'), makeNode('Contact'), makeNode('Account')],
          [
            { ...edge('Account', 'Order'), required: true },
            edge('Order', 'Contact'),
            edge('Contact', 'Account'),
          ],
        );

        await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: FIRST_ORDER,
          rootObjectApiName: 'Order',
        });

        expect(inserted['Account'].map((r) => r['Name']).sort()).toEqual([
          'Other account',
          'Root account',
        ]);
        expect(inserted['Order']).toEqual([
          expect.objectContaining({ Name: 'Root order', AccountId: 'Account:Root account' }),
        ]);
      });

      it('lists what a dry run would insert of them', async () => {
        const { orgDeps, graph } = ordersOfAnOpportunity();

        await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: OPPORTUNITY,
          rootObjectApiName: 'Opportunity',
          dryRun: true,
        });

        expect(progressEvents.map((e) => e.message)).toContain(
          '[dry-run] OrderAction: 2 record(s) would be inserted',
        );
      });
    });

    describe('a required lookup at an object the run does not read', () => {
      const FIRST_USER = '005000000000001AAA';
      const SECOND_USER = '005000000000002AAA';
      /** The system lookups every record carries, all three required, all at a User. */
      const auditFields: FieldInfo[] = [
        lookup('OwnerId', 'User', true),
        { ...lookup('CreatedById', 'User', true), createable: false },
        { ...lookup('LastModifiedById', 'User', true), createable: false },
      ];
      const madeBy = (user: string): FakeRow => ({
        OwnerId: user,
        CreatedById: user,
        LastModifiedById: user,
      });

      it('clones the contacts of the root account whoever owns, created or last changed them', async () => {
        // A User is never read: every lookup at one caches the id it meets,
        // and the required ones held each later read to the users the rows
        // before had named. Run against a sandbox, a contact of another user
        // would have been left out without an error.
        const { orgDeps, inserted } = fakeOrgs(
          {
            Account: [{ Id: ACCOUNT, Name: 'Root', ...madeBy(FIRST_USER) }],
            Contact: [
              { Id: KEY_CONTACT, LastName: 'Mine', AccountId: ACCOUNT, ...madeBy(FIRST_USER) },
              { Id: OTHER_CONTACT, LastName: 'Theirs', AccountId: ACCOUNT, ...madeBy(SECOND_USER) },
            ],
            AccountContactRelation: [
              {
                Id: '07k000000000001AAA',
                AccountId: ACCOUNT,
                ContactId: KEY_CONTACT,
                ...madeBy(FIRST_USER),
              },
              {
                Id: '07k000000000002AAA',
                AccountId: ACCOUNT,
                ContactId: OTHER_CONTACT,
                ...madeBy(SECOND_USER),
              },
              // The second contact's place at an account the run never reads:
              // still held out, by the account, which is read.
              {
                Id: '07k000000000003AAA',
                AccountId: ELSEWHERE_ACCOUNT,
                ContactId: OTHER_CONTACT,
                ...madeBy(SECOND_USER),
              },
            ],
          },
          {
            Account: [idField, text('Name'), ...auditFields],
            Contact: [idField, text('LastName'), lookup('AccountId', 'Account'), ...auditFields],
            AccountContactRelation: [
              idField,
              lookup('AccountId', 'Account', true),
              lookup('ContactId', 'Contact', true),
              ...auditFields.slice(1),
            ],
          },
        );
        const graph = makeGraph(
          [makeNode('Account'), makeNode('Contact'), makeNode('AccountContactRelation')],
          [
            edge('Account', 'Contact'),
            edge('Account', 'AccountContactRelation'),
            edge('Contact', 'AccountContactRelation'),
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
        });

        expect(inserted['Contact'].map((r) => r['LastName'])).toEqual(['Mine', 'Theirs']);
        expect(inserted['AccountContactRelation'].map((r) => r['ContactId'])).toEqual([
          'Contact:Mine',
          'Contact:Theirs',
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('holds price book entries to the standard book it matches, when the graph leaves price books out', async () => {
        // The standard book is never read, only matched, and the entries in
        // it can be written. A custom book the graph leaves out cannot be: its
        // entries stay out, as they did while every cached id narrowed.
        const PRODUCT = '01t000000000001AAA';
        const STANDARD_BOOK = '01s000000000001AAA';
        const CUSTOM_BOOK = '01s000000000002AAA';
        const { orgDeps, inserted } = fakeOrgs(
          {
            Product2: [{ Id: PRODUCT, Name: 'Widget' }],
            Pricebook2: [
              { Id: STANDARD_BOOK, IsStandard: true },
              { Id: CUSTOM_BOOK, IsStandard: false },
            ],
            PricebookEntry: [
              {
                Id: '01u000000000001AAA',
                Product2Id: PRODUCT,
                Pricebook2Id: STANDARD_BOOK,
                UnitPrice: '10',
              },
              {
                Id: '01u000000000002AAA',
                Product2Id: PRODUCT,
                Pricebook2Id: CUSTOM_BOOK,
                UnitPrice: '8',
              },
            ],
          },
          {
            Product2: [idField, text('Name')],
            PricebookEntry: [
              idField,
              lookup('Product2Id', 'Product2', true),
              lookup('Pricebook2Id', 'Pricebook2', true),
              text('UnitPrice'),
            ],
          },
        );
        const graph = makeGraph(
          [
            makeNode('Product2'),
            makeNode('PricebookEntry'),
            makeNode('Pricebook2', { included: false }),
          ],
          [edge('Product2', 'PricebookEntry')],
        );

        await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: PRODUCT,
          rootObjectApiName: 'Product2',
        });

        expect(inserted['PricebookEntry']).toEqual([
          { Product2Id: 'Product2:Widget', Pricebook2Id: STANDARD_BOOK, UnitPrice: '10' },
        ]);
      });
    });

    describe('the catalog a clone prices from', () => {
      const OPPORTUNITY = '006000000000001AAA';
      const OTHER_OPPORTUNITY = '006000000000002AAA';
      const STANDARD_BOOK = '01s000000000001AAA';
      const CUSTOM_BOOK = '01s000000000002AAA';
      const QUOTE_BOOK = '01s000000000003AAA';
      const BOOKS = { standard: [STANDARD_BOOK, 1], custom: [CUSTOM_BOOK, 2] } as const;
      const product = (n: number): string => `01t00000000000${n}AAA`;
      const price = (book: keyof typeof BOOKS, n: number): string =>
        `01u0000000000${BOOKS[book][1]}${n}AAA`;
      /** A price of widget `n` in `book`, named after both. */
      const priceRow = (book: keyof typeof BOOKS, n: number, unitPrice: string): FakeRow => ({
        Id: price(book, n),
        Name: `Widget ${n} ${book}`,
        Pricebook2Id: BOOKS[book][0],
        Product2Id: product(n),
        UnitPrice: unitPrice,
      });
      /** Six widgets, each priced in the standard book and in the custom one. */
      const catalogTables = (): Record<string, FakeRow[]> => ({
        Pricebook2: [
          { Id: STANDARD_BOOK, Name: 'Standard', IsStandard: true },
          { Id: CUSTOM_BOOK, Name: 'Custom', IsStandard: false },
          { Id: QUOTE_BOOK, Name: 'Quotes', IsStandard: false },
        ],
        Product2: [1, 2, 3, 4, 5, 6].map((n) => ({ Id: product(n), Name: `Widget ${n}` })),
        PricebookEntry: [1, 2, 3, 4, 5, 6].flatMap((n) => [
          priceRow('standard', n, '10'),
          priceRow('custom', n, '8'),
        ]),
      });
      const catalogFields: Record<string, FieldInfo[]> = {
        Pricebook2: [idField, text('Name'), { ...text('IsStandard'), createable: false }],
        Product2: [idField, text('Name')],
        PricebookEntry: [
          idField,
          text('Name'),
          lookup('Pricebook2Id', 'Pricebook2', true),
          lookup('Product2Id', 'Product2', true),
          text('UnitPrice'),
        ],
      };

      it('reads the prices its line items use and their standard prices, not the whole price book', async () => {
        // The opportunity's price book holds six prices and its line items
        // use three. Price book entries come before line items in
        // parents-first order, so they used to be read under the price books
        // in scope — the opportunity's, and the standard one matched for the
        // standard prices — and run between two sandboxes, three line items
        // brought 171 prices and all 146 products.
        const { orgDeps, inserted } = fakeOrgs(
          {
            ...catalogTables(),
            Opportunity: [
              { Id: OPPORTUNITY, Name: 'Deal', Pricebook2Id: CUSTOM_BOOK },
              { Id: OTHER_OPPORTUNITY, Name: 'Other deal', Pricebook2Id: CUSTOM_BOOK },
            ],
            OpportunityLineItem: [
              ...[1, 2, 3].map((n) => ({
                Id: `00k00000000000${n}AAA`,
                OpportunityId: OPPORTUNITY,
                PricebookEntryId: price('custom', n),
                Product2Id: product(n),
                Quantity: String(n),
              })),
              {
                Id: '00k000000000004AAA',
                OpportunityId: OTHER_OPPORTUNITY,
                PricebookEntryId: price('custom', 4),
                Product2Id: product(4),
                Quantity: '4',
              },
            ],
          },
          {
            ...catalogFields,
            Opportunity: [idField, text('Name'), lookup('Pricebook2Id', 'Pricebook2')],
            OpportunityLineItem: [
              idField,
              lookup('OpportunityId', 'Opportunity', true),
              // Nullable in the describe, required by the platform.
              lookup('PricebookEntryId', 'PricebookEntry'),
              lookup('Product2Id', 'Product2'),
              text('Quantity'),
            ],
          },
        );
        const read = recordReads(orgDeps);
        // The graph discovery builds two levels around an opportunity: the
        // price book entry sits at the edge of it, its own lookups unwalked.
        const graph = makeGraph(
          [
            makeNode('Opportunity'),
            makeNode('Pricebook2'),
            makeNode('Product2'),
            makeNode('OpportunityLineItem'),
            makeNode('PricebookEntry'),
          ],
          [
            edge('Pricebook2', 'Opportunity'),
            edge('Opportunity', 'OpportunityLineItem'),
            { ...edge('PricebookEntry', 'OpportunityLineItem'), required: true },
            edge('Product2', 'OpportunityLineItem'),
            edge('Pricebook2', 'PricebookEntry'),
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: OPPORTUNITY,
          rootObjectApiName: 'Opportunity',
        });

        expect(read['PricebookEntry']).toEqual(
          new Set([1, 2, 3].flatMap((n) => [price('custom', n), price('standard', n)])),
        );
        expect(read['Product2']).toEqual(new Set([1, 2, 3].map(product)));
        // Products, then the standard prices, then the custom ones, then the
        // line items that point at them — and the opportunity after the price
        // book it names.
        expect(Object.keys(inserted)).toEqual([
          'Pricebook2',
          'Product2',
          'Opportunity',
          'PricebookEntry',
          'OpportunityLineItem',
        ]);
        expect(inserted['Product2'].map((r) => r['Name'])).toEqual([
          'Widget 1',
          'Widget 2',
          'Widget 3',
        ]);
        expect(inserted['PricebookEntry'].map((r) => r['Name'])).toEqual([
          'Widget 1 standard',
          'Widget 2 standard',
          'Widget 3 standard',
          'Widget 1 custom',
          'Widget 2 custom',
          'Widget 3 custom',
        ]);
        expect(inserted['PricebookEntry'].slice(3).map((r) => r['Pricebook2Id'])).toEqual([
          'Pricebook2:Custom',
          'Pricebook2:Custom',
          'Pricebook2:Custom',
        ]);
        // The standard book is matched, never cloned.
        expect(inserted['Pricebook2'].map((r) => r['Name'])).toEqual(['Custom']);
        expect(inserted['OpportunityLineItem'].map((r) => r['PricebookEntryId'])).toEqual([
          'PricebookEntry:Widget 1 custom',
          'PricebookEntry:Widget 2 custom',
          'PricebookEntry:Widget 3 custom',
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('brings the price book of a price only a quote line points at', async () => {
        // A quote of the opportunity is priced from a book of its own. Its
        // line was held to the prices named so far — the one the
        // opportunity's line item uses — and left out without an error; the
        // price it uses, and that book, with it.
        const QUOTE = '0Q0000000000001AAA';
        const QUOTE_PRICE = '01u000000000035AAA';
        const LINE_ITEM = '00k000000000001AAA';
        const tables = catalogTables();
        tables['PricebookEntry'].push({
          Id: QUOTE_PRICE,
          Name: 'Widget 5 quotes',
          Pricebook2Id: QUOTE_BOOK,
          Product2Id: product(5),
          UnitPrice: '9',
        });
        const { orgDeps, inserted } = fakeOrgs(
          {
            ...tables,
            Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal', Pricebook2Id: CUSTOM_BOOK }],
            OpportunityLineItem: [
              {
                Id: LINE_ITEM,
                OpportunityId: OPPORTUNITY,
                PricebookEntryId: price('custom', 1),
                Product2Id: product(1),
                Quantity: '2',
              },
            ],
            Quote: [
              {
                Id: QUOTE,
                Name: 'Offer',
                OpportunityId: OPPORTUNITY,
                Pricebook2Id: QUOTE_BOOK,
              },
            ],
            QuoteLineItem: [
              {
                Id: '0QL000000000001AAA',
                QuoteId: QUOTE,
                OpportunityLineItemId: null,
                PricebookEntryId: QUOTE_PRICE,
                Product2Id: product(5),
                Quantity: '1',
              },
            ],
          },
          {
            ...catalogFields,
            Opportunity: [idField, text('Name'), lookup('Pricebook2Id', 'Pricebook2')],
            OpportunityLineItem: [
              idField,
              lookup('OpportunityId', 'Opportunity', true),
              lookup('PricebookEntryId', 'PricebookEntry'),
              lookup('Product2Id', 'Product2'),
              text('Quantity'),
            ],
            Quote: [
              idField,
              text('Name'),
              lookup('OpportunityId', 'Opportunity'),
              lookup('Pricebook2Id', 'Pricebook2'),
            ],
            QuoteLineItem: [
              idField,
              lookup('QuoteId', 'Quote', true),
              lookup('OpportunityLineItemId', 'OpportunityLineItem'),
              lookup('PricebookEntryId', 'PricebookEntry', true),
              lookup('Product2Id', 'Product2', true),
              text('Quantity'),
            ],
          },
        );
        const read = recordReads(orgDeps);
        const graph = makeGraph(
          [
            makeNode('Opportunity'),
            makeNode('Pricebook2'),
            makeNode('Quote'),
            makeNode('Product2'),
            makeNode('OpportunityLineItem'),
            makeNode('QuoteLineItem'),
            makeNode('PricebookEntry'),
          ],
          [
            edge('Pricebook2', 'Opportunity'),
            edge('Opportunity', 'Quote'),
            edge('Pricebook2', 'Quote'),
            edge('Opportunity', 'OpportunityLineItem'),
            { ...edge('PricebookEntry', 'OpportunityLineItem'), required: true },
            edge('Product2', 'OpportunityLineItem'),
            edge('OpportunityLineItem', 'QuoteLineItem'),
            { ...edge('Quote', 'QuoteLineItem'), required: true },
            { ...edge('PricebookEntry', 'QuoteLineItem'), required: true },
            { ...edge('Product2', 'QuoteLineItem'), required: true },
            { ...edge('Pricebook2', 'PricebookEntry'), required: true },
            { ...edge('Product2', 'PricebookEntry'), required: true },
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: OPPORTUNITY,
          rootObjectApiName: 'Opportunity',
        });

        expect(read['PricebookEntry']).toEqual(
          new Set([price('custom', 1), QUOTE_PRICE, price('standard', 1), price('standard', 5)]),
        );
        expect(inserted['Pricebook2'].map((r) => r['Name'])).toEqual(['Custom', 'Quotes']);
        expect(inserted['PricebookEntry'].map((r) => r['Name'])).toEqual([
          'Widget 1 standard',
          'Widget 5 standard',
          'Widget 1 custom',
          'Widget 5 quotes',
        ]);
        expect(inserted['QuoteLineItem']).toEqual([
          {
            QuoteId: 'Quote:Offer',
            PricebookEntryId: 'PricebookEntry:Widget 5 quotes',
            Product2Id: 'Product2:Widget 5',
            Quantity: '1',
          },
        ]);
        expect(summary.errors).toEqual([]);
      });

      describe('a record put off until the first pass is done', () => {
        // The asset a line renews sits at the edge of the graph: a parent of
        // the line, so its turn comes before it, when nothing read names it
        // yet. It is put off, and asked again once the first pass is done —
        // after the catalog, which read by what had been named so far left
        // out the product the asset was sold as, and the price it was sold at.
        // Each product is based on a classification, which nothing but the
        // products names: put off as well, and read after them.
        const ASSET = '02i000000000001AAA';
        const OLD_PRICE = '01u000000000036AAA';
        const HARDWARE = '11B000000000001AAA';
        const LEGACY = '11B000000000002AAA';

        function assetOrgs() {
          const tables = catalogTables();
          tables['Product2'] = tables['Product2'].map((row) => ({
            ...row,
            BasedOnId: row['Id'] === product(6) ? LEGACY : HARDWARE,
          }));
          // Widget 6's old price, in a book nothing else in the clone uses.
          tables['PricebookEntry'].push({
            Id: OLD_PRICE,
            Name: 'Widget 6 quotes',
            Pricebook2Id: QUOTE_BOOK,
            Product2Id: product(6),
            UnitPrice: '12',
          });
          return fakeOrgs(
            {
              ...tables,
              Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal', Pricebook2Id: CUSTOM_BOOK }],
              OpportunityLineItem: [
                {
                  Id: '00k000000000001AAA',
                  OpportunityId: OPPORTUNITY,
                  PricebookEntryId: price('custom', 1),
                  Product2Id: product(1),
                  Renewed_Asset__c: ASSET,
                  Quantity: '1',
                },
              ],
              Asset: [
                {
                  Id: ASSET,
                  Name: 'Installed widget',
                  Product2Id: product(6),
                  Sold_At__c: OLD_PRICE,
                },
              ],
              ProductClassification: [
                { Id: HARDWARE, Name: 'Hardware' },
                { Id: LEGACY, Name: 'Legacy' },
                { Id: '11B000000000003AAA', Name: 'Services' },
              ],
            },
            {
              ...catalogFields,
              Product2: [
                ...catalogFields['Product2'],
                lookup('BasedOnId', 'ProductClassification'),
              ],
              ProductClassification: [idField, text('Name')],
              Opportunity: [idField, text('Name'), lookup('Pricebook2Id', 'Pricebook2')],
              OpportunityLineItem: [
                idField,
                lookup('OpportunityId', 'Opportunity', true),
                lookup('PricebookEntryId', 'PricebookEntry'),
                lookup('Product2Id', 'Product2'),
                lookup('Renewed_Asset__c', 'Asset'),
                text('Quantity'),
              ],
              Asset: [
                idField,
                text('Name'),
                lookup('Product2Id', 'Product2'),
                lookup('Sold_At__c', 'PricebookEntry'),
              ],
            },
          );
        }

        /** Two levels around the opportunity; the asset's and the product's lookups are walked. */
        function assetGraph(): ForgeGraph {
          return makeGraph(
            [
              makeNode('Opportunity'),
              makeNode('Pricebook2'),
              makeNode('ProductClassification'),
              makeNode('Product2'),
              makeNode('PricebookEntry'),
              makeNode('Asset'),
              makeNode('OpportunityLineItem'),
            ],
            [
              edge('Pricebook2', 'Opportunity'),
              edge('ProductClassification', 'Product2'),
              edge('Product2', 'Asset'),
              edge('PricebookEntry', 'Asset'),
              edge('Opportunity', 'OpportunityLineItem'),
              edge('Asset', 'OpportunityLineItem'),
              { ...edge('PricebookEntry', 'OpportunityLineItem'), required: true },
              edge('Product2', 'OpportunityLineItem'),
              { ...edge('Pricebook2', 'PricebookEntry'), required: true },
              { ...edge('Product2', 'PricebookEntry'), required: true },
            ],
          );
        }

        it('reads the catalog after it, for the product and the price only it names', async () => {
          const { orgDeps, inserted, updated } = assetOrgs();
          const read = recordReads(orgDeps);

          const summary = await new ForgeExecutor(orgDeps).execute(
            assetGraph(),
            'src',
            'tgt',
            onProgress,
            { rootRecordId: OPPORTUNITY, rootObjectApiName: 'Opportunity' },
          );

          expect(read['Product2']).toEqual(new Set([product(1), product(6)]));
          expect(read['PricebookEntry']).toEqual(
            new Set([price('custom', 1), price('standard', 1), OLD_PRICE, price('standard', 6)]),
          );
          expect(inserted['Product2'].map((r) => r['Name'])).toEqual(['Widget 1', 'Widget 6']);
          expect(inserted['Pricebook2'].map((r) => r['Name'])).toEqual(['Custom', 'Quotes']);
          expect(inserted['PricebookEntry'].map((r) => r['Name'])).toEqual([
            'Widget 1 standard',
            'Widget 6 standard',
            'Widget 1 custom',
            'Widget 6 quotes',
          ]);
          expect(inserted['Asset']).toEqual([
            {
              Name: 'Installed widget',
              Product2Id: 'Product2:Widget 6',
              Sold_At__c: 'PricebookEntry:Widget 6 quotes',
            },
          ]);
          expect(updated).toEqual([]);
          expect(summary.errors).toEqual([]);
        });

        it('still reads after the catalog what its rows name, the classification of that product among them', async () => {
          const { orgDeps, inserted } = assetOrgs();
          const read = recordReads(orgDeps);

          const summary = await new ForgeExecutor(orgDeps).execute(
            assetGraph(),
            'src',
            'tgt',
            onProgress,
            { rootRecordId: OPPORTUNITY, rootObjectApiName: 'Opportunity' },
          );

          expect(read['ProductClassification']).toEqual(new Set([HARDWARE, LEGACY]));
          expect(inserted['ProductClassification'].map((r) => r['Name'])).toEqual([
            'Hardware',
            'Legacy',
          ]);
          expect(inserted['Product2']).toEqual([
            { Name: 'Widget 1', BasedOnId: 'ProductClassification:Hardware' },
            { Name: 'Widget 6', BasedOnId: 'ProductClassification:Legacy' },
          ]);
          expect(summary.errors).toEqual([]);
        });
      });

      it('still brings every price of a price book it is rooted at, with only their standard prices', async () => {
        // Rooted at the catalog, the book is what is cloned. The standard
        // book matched beside it used to count as a book in scope as well,
        // and brought its every price — widgets 5 and 6 included, which the
        // cloned book does not sell.
        const tables = catalogTables();
        tables['PricebookEntry'] = tables['PricebookEntry'].filter(
          (row) => row['Id'] !== price('custom', 5) && row['Id'] !== price('custom', 6),
        );
        const { orgDeps, inserted } = fakeOrgs(tables, catalogFields);
        const read = recordReads(orgDeps);
        // Two levels around a price book: its prices are walked, and their
        // lookups with them.
        const graph = makeGraph(
          [makeNode('Pricebook2'), makeNode('PricebookEntry'), makeNode('Product2')],
          [
            { ...edge('Pricebook2', 'PricebookEntry'), required: true },
            { ...edge('Product2', 'PricebookEntry'), required: true },
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: CUSTOM_BOOK,
          rootObjectApiName: 'Pricebook2',
        });

        expect(read['PricebookEntry']).toEqual(
          new Set([1, 2, 3, 4].flatMap((n) => [price('custom', n), price('standard', n)])),
        );
        expect(inserted['Pricebook2'].map((r) => r['Name'])).toEqual(['Custom']);
        expect(inserted['Product2'].map((r) => r['Name'])).toEqual([
          'Widget 1',
          'Widget 2',
          'Widget 3',
          'Widget 4',
        ]);
        expect(inserted['PricebookEntry'].map((r) => r['Name'])).toEqual([
          'Widget 1 standard',
          'Widget 2 standard',
          'Widget 3 standard',
          'Widget 4 standard',
          'Widget 1 custom',
          'Widget 2 custom',
          'Widget 3 custom',
          'Widget 4 custom',
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('clones the other books the records of a price book it is rooted at name', async () => {
        // An opportunity priced from the book has a quote priced from another
        // one. The book the clone is rooted at was read by its id alone, once,
        // before anything named another: the quote went to the target without
        // its book, and its line's price with no book at all.
        const QUOTE = '0Q0000000000001AAA';
        const QUOTE_PRICE = '01u000000000035AAA';
        const UNSOLD_QUOTE_PRICE = '01u000000000036AAA';
        const tables = catalogTables();
        tables['PricebookEntry'].push(
          {
            Id: QUOTE_PRICE,
            Name: 'Widget 5 quotes',
            Pricebook2Id: QUOTE_BOOK,
            Product2Id: product(5),
            UnitPrice: '9',
          },
          {
            Id: UNSOLD_QUOTE_PRICE,
            Name: 'Widget 6 quotes',
            Pricebook2Id: QUOTE_BOOK,
            Product2Id: product(6),
            UnitPrice: '9',
          },
        );
        const { orgDeps, inserted } = fakeOrgs(
          {
            ...tables,
            Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal', Pricebook2Id: CUSTOM_BOOK }],
            Quote: [
              { Id: QUOTE, Name: 'Offer', OpportunityId: OPPORTUNITY, Pricebook2Id: QUOTE_BOOK },
            ],
            QuoteLineItem: [
              {
                Id: '0QL000000000001AAA',
                QuoteId: QUOTE,
                PricebookEntryId: QUOTE_PRICE,
                Product2Id: product(5),
                Quantity: '1',
              },
            ],
          },
          {
            ...catalogFields,
            Opportunity: [idField, text('Name'), lookup('Pricebook2Id', 'Pricebook2')],
            Quote: [
              idField,
              text('Name'),
              lookup('OpportunityId', 'Opportunity'),
              lookup('Pricebook2Id', 'Pricebook2'),
            ],
            QuoteLineItem: [
              idField,
              lookup('QuoteId', 'Quote', true),
              lookup('PricebookEntryId', 'PricebookEntry', true),
              lookup('Product2Id', 'Product2', true),
              text('Quantity'),
            ],
          },
        );
        const read = recordReads(orgDeps);
        const graph = makeGraph(
          [
            makeNode('Pricebook2'),
            makeNode('PricebookEntry'),
            makeNode('Opportunity'),
            makeNode('Quote'),
            makeNode('Product2'),
            makeNode('QuoteLineItem'),
          ],
          [
            { ...edge('Pricebook2', 'PricebookEntry'), required: true },
            { ...edge('Product2', 'PricebookEntry'), required: true },
            edge('Pricebook2', 'Opportunity'),
            edge('Pricebook2', 'Quote'),
            edge('Opportunity', 'Quote'),
            { ...edge('Quote', 'QuoteLineItem'), required: true },
            { ...edge('PricebookEntry', 'QuoteLineItem'), required: true },
            { ...edge('Product2', 'QuoteLineItem'), required: true },
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: CUSTOM_BOOK,
          rootObjectApiName: 'Pricebook2',
        });

        // Named, the other book is read by its id, and brings none of its prices.
        expect(read['PricebookEntry'].has(QUOTE_PRICE)).toBe(true);
        expect(read['PricebookEntry'].has(UNSOLD_QUOTE_PRICE)).toBe(false);
        expect(inserted['Pricebook2'].map((r) => r['Name'])).toEqual(['Custom', 'Quotes']);
        expect(inserted['Quote']).toEqual([
          { Name: 'Offer', OpportunityId: 'Opportunity:Deal', Pricebook2Id: 'Pricebook2:Quotes' },
        ]);
        expect(
          inserted['PricebookEntry'].find((r) => r['Name'] === 'Widget 5 quotes'),
        ).toMatchObject({ Product2Id: 'Product2:Widget 5', Pricebook2Id: 'Pricebook2:Quotes' });
        expect(inserted['QuoteLineItem']).toEqual([
          {
            QuoteId: 'Quote:Offer',
            PricebookEntryId: 'PricebookEntry:Widget 5 quotes',
            Product2Id: 'Product2:Widget 5',
            Quantity: '1',
          },
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('reads the standard prices of 700 products in statements a request URI holds', async () => {
        // The standard prices were asked for in one statement naming every
        // product the custom prices use. Past some six hundred products it no
        // longer fit the request URI a query travels in, which the org
        // refuses: the run went on without a single standard price, and the
        // platform refuses a custom price that has none.
        const widgets = Array.from({ length: 700 }, (_, i) => i + 1);
        const widget = (n: number): string => `01t${String(n).padStart(15, '0')}`;
        const priceOf = (book: 1 | 2, n: number): string =>
          `01u${book}${String(n).padStart(14, '0')}`;
        const { orgDeps, inserted } = fakeOrgs(
          {
            Pricebook2: [
              { Id: STANDARD_BOOK, Name: 'Standard', IsStandard: true },
              { Id: CUSTOM_BOOK, Name: 'Custom', IsStandard: false },
            ],
            Product2: widgets.map((n) => ({ Id: widget(n), Name: `Widget ${n}` })),
            PricebookEntry: widgets.flatMap((n) => [
              {
                Id: priceOf(1, n),
                Name: `Widget ${n} standard`,
                Pricebook2Id: STANDARD_BOOK,
                Product2Id: widget(n),
                UnitPrice: '10',
              },
              {
                Id: priceOf(2, n),
                Name: `Widget ${n} custom`,
                Pricebook2Id: CUSTOM_BOOK,
                Product2Id: widget(n),
                UnitPrice: '8',
              },
            ]),
            Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal', Pricebook2Id: CUSTOM_BOOK }],
            OpportunityLineItem: widgets.map((n) => ({
              Id: `00k${String(n).padStart(15, '0')}`,
              OpportunityId: OPPORTUNITY,
              PricebookEntryId: priceOf(2, n),
              Product2Id: widget(n),
              Quantity: '1',
            })),
          },
          {
            ...catalogFields,
            Opportunity: [idField, text('Name'), lookup('Pricebook2Id', 'Pricebook2')],
            OpportunityLineItem: [
              idField,
              lookup('OpportunityId', 'Opportunity', true),
              lookup('PricebookEntryId', 'PricebookEntry'),
              lookup('Product2Id', 'Product2'),
              text('Quantity'),
            ],
          },
        );
        // Salesforce refuses a request URI much past 16 000 characters.
        const sent: string[] = [];
        const query = orgDeps.queryRecords;
        orgDeps.queryRecords = async (org, soql, onTruncated) => {
          sent.push(soql);
          if (encodeURIComponent(soql).length > 16_000) throw new Error('414 URI Too Long');
          return query(org, soql, onTruncated);
        };
        const graph = makeGraph(
          [
            makeNode('Opportunity'),
            makeNode('Pricebook2'),
            makeNode('Product2'),
            makeNode('OpportunityLineItem'),
            makeNode('PricebookEntry'),
          ],
          [
            edge('Pricebook2', 'Opportunity'),
            edge('Opportunity', 'OpportunityLineItem'),
            { ...edge('PricebookEntry', 'OpportunityLineItem'), required: true },
            edge('Product2', 'OpportunityLineItem'),
            edge('Pricebook2', 'PricebookEntry'),
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: OPPORTUNITY,
          rootObjectApiName: 'Opportunity',
        });

        expect(summary.errors).toEqual([]);
        expect(
          inserted['PricebookEntry'].filter((row) => row['Pricebook2Id'] === STANDARD_BOOK),
        ).toHaveLength(widgets.length);
        expect(sent.filter((soql) => encodeURIComponent(soql).length > 16_000)).toEqual([]);
      });

      it('writes the standard price of the currency its custom price is in', async () => {
        // An org with several currencies prices a product once per currency
        // in each book, and a custom price needs the standard price of its own
        // currency. One standard price was kept per product, the first read,
        // in dollars, and the custom price in euros the line uses had none.
        // The one in dollars, which no price of the clone is in, stays behind.
        const tables = catalogTables();
        tables['PricebookEntry'] = [
          {
            ...priceRow('standard', 1, '10'),
            Name: 'Widget 1 standard USD',
            CurrencyIsoCode: 'USD',
          },
          {
            ...priceRow('standard', 1, '9'),
            Id: `${price('standard', 1).slice(0, 15)}EUR`,
            Name: 'Widget 1 standard EUR',
            CurrencyIsoCode: 'EUR',
          },
          { ...priceRow('custom', 1, '8'), Name: 'Widget 1 custom EUR', CurrencyIsoCode: 'EUR' },
        ];
        const { orgDeps, inserted } = fakeOrgs(
          {
            ...tables,
            Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal', Pricebook2Id: CUSTOM_BOOK }],
            OpportunityLineItem: [
              {
                Id: '00k000000000001AAA',
                OpportunityId: OPPORTUNITY,
                PricebookEntryId: price('custom', 1),
                Product2Id: product(1),
                Quantity: '1',
              },
            ],
          },
          {
            ...catalogFields,
            PricebookEntry: [...catalogFields['PricebookEntry'], text('CurrencyIsoCode')],
            Opportunity: [idField, text('Name'), lookup('Pricebook2Id', 'Pricebook2')],
            OpportunityLineItem: [
              idField,
              lookup('OpportunityId', 'Opportunity', true),
              lookup('PricebookEntryId', 'PricebookEntry'),
              lookup('Product2Id', 'Product2'),
              text('Quantity'),
            ],
          },
        );
        const graph = makeGraph(
          [
            makeNode('Opportunity'),
            makeNode('Pricebook2'),
            makeNode('Product2'),
            makeNode('OpportunityLineItem'),
            makeNode('PricebookEntry'),
          ],
          [
            edge('Pricebook2', 'Opportunity'),
            edge('Opportunity', 'OpportunityLineItem'),
            { ...edge('PricebookEntry', 'OpportunityLineItem'), required: true },
            edge('Product2', 'OpportunityLineItem'),
            edge('Pricebook2', 'PricebookEntry'),
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: OPPORTUNITY,
          rootObjectApiName: 'Opportunity',
        });

        expect(inserted['PricebookEntry'].map((r) => r['Name'])).toEqual([
          'Widget 1 standard EUR',
          'Widget 1 custom EUR',
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('takes the standard price of each currency its lines use, and of no other', async () => {
        // The books price every widget once per currency the org holds. A deal
        // in euros and one in dollars each use one custom price, and the
        // standard prices were taken by product: all three currencies of both
        // widgets, four of them standard prices no price the clone writes needs.
        const priceIn = (book: 'standard' | 'custom', n: number, currency: string): FakeRow => ({
          ...priceRow(book, n, book === 'standard' ? '10' : '8'),
          Id: `${price(book, n).slice(0, 15)}${currency}`,
          Name: `Widget ${n} ${book} ${currency}`,
          CurrencyIsoCode: currency,
        });
        const tables = catalogTables();
        tables['PricebookEntry'] = [1, 2].flatMap((n) =>
          (['standard', 'custom'] as const).flatMap((book) =>
            ['USD', 'EUR', 'GBP'].map((currency) => priceIn(book, n, currency)),
          ),
        );
        const { orgDeps, inserted } = fakeOrgs(
          {
            ...tables,
            Account: [{ Id: ACCOUNT, Name: 'Acme' }],
            Opportunity: [
              {
                Id: OPPORTUNITY,
                Name: 'Euro deal',
                AccountId: ACCOUNT,
                Pricebook2Id: CUSTOM_BOOK,
                CurrencyIsoCode: 'EUR',
              },
              {
                Id: OTHER_OPPORTUNITY,
                Name: 'Dollar deal',
                AccountId: ACCOUNT,
                Pricebook2Id: CUSTOM_BOOK,
                CurrencyIsoCode: 'USD',
              },
            ],
            OpportunityLineItem: [
              {
                Id: '00k000000000001AAA',
                OpportunityId: OPPORTUNITY,
                PricebookEntryId: priceIn('custom', 1, 'EUR')['Id'],
                Product2Id: product(1),
                Quantity: '1',
              },
              {
                Id: '00k000000000002AAA',
                OpportunityId: OTHER_OPPORTUNITY,
                PricebookEntryId: priceIn('custom', 2, 'USD')['Id'],
                Product2Id: product(2),
                Quantity: '1',
              },
            ],
          },
          {
            ...catalogFields,
            PricebookEntry: [...catalogFields['PricebookEntry'], text('CurrencyIsoCode')],
            Account: [idField, text('Name')],
            Opportunity: [
              idField,
              text('Name'),
              lookup('AccountId', 'Account'),
              lookup('Pricebook2Id', 'Pricebook2'),
              text('CurrencyIsoCode'),
            ],
            OpportunityLineItem: [
              idField,
              lookup('OpportunityId', 'Opportunity', true),
              lookup('PricebookEntryId', 'PricebookEntry'),
              lookup('Product2Id', 'Product2'),
              text('Quantity'),
            ],
          },
        );
        const graph = makeGraph(
          [
            makeNode('Account'),
            makeNode('Opportunity'),
            makeNode('Pricebook2'),
            makeNode('Product2'),
            makeNode('OpportunityLineItem'),
            makeNode('PricebookEntry'),
          ],
          [
            edge('Account', 'Opportunity'),
            edge('Pricebook2', 'Opportunity'),
            edge('Opportunity', 'OpportunityLineItem'),
            { ...edge('PricebookEntry', 'OpportunityLineItem'), required: true },
            edge('Product2', 'OpportunityLineItem'),
            edge('Pricebook2', 'PricebookEntry'),
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
        });

        expect(inserted['PricebookEntry'].map((r) => r['Name'])).toEqual([
          'Widget 1 standard EUR',
          'Widget 2 standard USD',
          'Widget 1 custom EUR',
          'Widget 2 custom USD',
        ]);
        expect(inserted['OpportunityLineItem'].map((r) => r['PricebookEntryId'])).toEqual([
          'PricebookEntry:Widget 1 custom EUR',
          'PricebookEntry:Widget 2 custom USD',
        ]);
        expect(progressEvents.map((e) => e.message)).toContain(
          'Added 2 standard price book entries the custom prices depend on',
        );
        expect(summary.errors).toEqual([]);
      });

      describe('a catalog the account in scope points at as well', () => {
        // Two levels around an opportunity take in its account and the
        // account's children: a product naming the account as its supplier, a
        // price book made for it. Each such lookup is a read under the account,
        // so the catalog counted as reached from above and was read at its turn
        // in parents-first order, before the lines had named any of it — and
        // never again. The products and books the lines named were left out,
        // and every price went to the target without them.
        const QUOTE = '0Q0000000000001AAA';
        const QUOTE_PRICE = '01u000000000035AAA';
        const ACCOUNT_BOOK = '01s000000000004AAA';
        const ACCOUNT_PRICE = '01u000000000044AAA';
        const rooted = { rootRecordId: OPPORTUNITY, rootObjectApiName: 'Opportunity' };

        /**
         * The opportunity's lines price widgets 1 to 3 from its book, and its
         * quote prices widget 5 from a book of its own. With `own`, the
         * account also supplies widget 6 and has a book pricing widget 4.
         */
        function accountCatalog(own: boolean) {
          const tables = catalogTables();
          tables['Product2'] = tables['Product2'].map((row) => ({
            ...row,
            Supplier__c: own && row['Id'] === product(6) ? ACCOUNT : null,
          }));
          tables['Pricebook2'] = tables['Pricebook2'].map((row) => ({ ...row, Account__c: null }));
          tables['PricebookEntry'].push({
            Id: QUOTE_PRICE,
            Name: 'Widget 5 quotes',
            Pricebook2Id: QUOTE_BOOK,
            Product2Id: product(5),
            UnitPrice: '9',
          });
          if (own) {
            tables['Pricebook2'].push({
              Id: ACCOUNT_BOOK,
              Name: 'Acme',
              IsStandard: false,
              Account__c: ACCOUNT,
            });
            tables['PricebookEntry'].push({
              Id: ACCOUNT_PRICE,
              Name: 'Widget 4 acme',
              Pricebook2Id: ACCOUNT_BOOK,
              Product2Id: product(4),
              UnitPrice: '7',
            });
          }
          return fakeOrgs(
            {
              ...tables,
              Account: [{ Id: ACCOUNT, Name: 'Acme' }],
              Opportunity: [
                { Id: OPPORTUNITY, Name: 'Deal', AccountId: ACCOUNT, Pricebook2Id: CUSTOM_BOOK },
              ],
              OpportunityLineItem: [1, 2, 3].map((n) => ({
                Id: `00k00000000000${n}AAA`,
                OpportunityId: OPPORTUNITY,
                PricebookEntryId: price('custom', n),
                Product2Id: product(n),
                Quantity: String(n),
              })),
              Quote: [
                { Id: QUOTE, Name: 'Offer', OpportunityId: OPPORTUNITY, Pricebook2Id: QUOTE_BOOK },
              ],
              QuoteLineItem: [
                {
                  Id: '0QL000000000001AAA',
                  QuoteId: QUOTE,
                  PricebookEntryId: QUOTE_PRICE,
                  Product2Id: product(5),
                  Quantity: '1',
                },
              ],
            },
            {
              ...catalogFields,
              Account: [idField, text('Name')],
              Pricebook2: [...catalogFields['Pricebook2'], lookup('Account__c', 'Account')],
              Product2: [...catalogFields['Product2'], lookup('Supplier__c', 'Account')],
              Opportunity: [
                idField,
                text('Name'),
                lookup('AccountId', 'Account'),
                lookup('Pricebook2Id', 'Pricebook2'),
              ],
              OpportunityLineItem: [
                idField,
                lookup('OpportunityId', 'Opportunity', true),
                lookup('PricebookEntryId', 'PricebookEntry'),
                lookup('Product2Id', 'Product2'),
                text('Quantity'),
              ],
              Quote: [
                idField,
                text('Name'),
                lookup('OpportunityId', 'Opportunity'),
                lookup('Pricebook2Id', 'Pricebook2'),
              ],
              QuoteLineItem: [
                idField,
                lookup('QuoteId', 'Quote', true),
                lookup('PricebookEntryId', 'PricebookEntry', true),
                lookup('Product2Id', 'Product2', true),
                text('Quantity'),
              ],
            },
          );
        }

        /** Two levels around the opportunity, the account's children included. */
        function accountGraph(): ForgeGraph {
          return makeGraph(
            [
              makeNode('Opportunity'),
              makeNode('Account'),
              makeNode('Pricebook2'),
              makeNode('Product2'),
              makeNode('Quote'),
              makeNode('OpportunityLineItem'),
              makeNode('QuoteLineItem'),
              makeNode('PricebookEntry'),
            ],
            [
              edge('Account', 'Opportunity'),
              edge('Pricebook2', 'Opportunity'),
              edge('Account', 'Product2'),
              edge('Account', 'Pricebook2'),
              edge('Opportunity', 'Quote'),
              edge('Pricebook2', 'Quote'),
              edge('Opportunity', 'OpportunityLineItem'),
              { ...edge('PricebookEntry', 'OpportunityLineItem'), required: true },
              edge('Product2', 'OpportunityLineItem'),
              { ...edge('Quote', 'QuoteLineItem'), required: true },
              { ...edge('PricebookEntry', 'QuoteLineItem'), required: true },
              { ...edge('Product2', 'QuoteLineItem'), required: true },
              { ...edge('Pricebook2', 'PricebookEntry'), required: true },
              { ...edge('Product2', 'PricebookEntry'), required: true },
            ],
          );
        }

        /** Each price written, by name: the product and the book it was sent with. */
        const pricesSent = (rows: Array<Record<string, unknown>> = []) =>
          Object.fromEntries(
            rows.map((row) => [String(row['Name']), [row['Product2Id'], row['Pricebook2Id']]]),
          );
        const names = (rows: Array<Record<string, unknown>> = []): string[] =>
          rows.map((row) => String(row['Name'])).sort();

        it('clones the products, prices and books its lines name', async () => {
          const { orgDeps, inserted } = accountCatalog(false);
          const read = recordReads(orgDeps);

          const summary = await new ForgeExecutor(orgDeps).execute(
            accountGraph(),
            'src',
            'tgt',
            onProgress,
            rooted,
          );

          expect(read['Product2']).toEqual(new Set([1, 2, 3, 5].map(product)));
          expect(names(inserted['Product2'])).toEqual([
            'Widget 1',
            'Widget 2',
            'Widget 3',
            'Widget 5',
          ]);
          expect(names(inserted['Pricebook2'])).toEqual(['Custom', 'Quotes']);
          expect(pricesSent(inserted['PricebookEntry'])).toEqual({
            'Widget 1 standard': ['Product2:Widget 1', STANDARD_BOOK],
            'Widget 2 standard': ['Product2:Widget 2', STANDARD_BOOK],
            'Widget 3 standard': ['Product2:Widget 3', STANDARD_BOOK],
            'Widget 5 standard': ['Product2:Widget 5', STANDARD_BOOK],
            'Widget 1 custom': ['Product2:Widget 1', 'Pricebook2:Custom'],
            'Widget 2 custom': ['Product2:Widget 2', 'Pricebook2:Custom'],
            'Widget 3 custom': ['Product2:Widget 3', 'Pricebook2:Custom'],
            'Widget 5 quotes': ['Product2:Widget 5', 'Pricebook2:Quotes'],
          });
          expect(inserted['OpportunityLineItem'].map((r) => r['PricebookEntryId'])).toEqual([
            'PricebookEntry:Widget 1 custom',
            'PricebookEntry:Widget 2 custom',
            'PricebookEntry:Widget 3 custom',
          ]);
          expect(inserted['QuoteLineItem']).toEqual([
            {
              QuoteId: 'Quote:Offer',
              PricebookEntryId: 'PricebookEntry:Widget 5 quotes',
              Product2Id: 'Product2:Widget 5',
              Quantity: '1',
            },
          ]);
          expect(summary.errors).toEqual([]);
        });

        it('still clones what the account reaches of the catalog, with the prices under it', async () => {
          // The widget the account supplies and the book made for it are
          // reached from above, and come with their prices as a book a clone
          // is rooted at does. Read at their turn, they also held every read
          // after them to what had been named so far: the quote line and the
          // account's price of a widget no line had named were left out.
          const { orgDeps, inserted } = accountCatalog(true);

          const summary = await new ForgeExecutor(orgDeps).execute(
            accountGraph(),
            'src',
            'tgt',
            onProgress,
            rooted,
          );

          expect(names(inserted['Product2'])).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Widget ${n}`));
          expect(names(inserted['Pricebook2'])).toEqual(['Acme', 'Custom', 'Quotes']);
          expect(pricesSent(inserted['PricebookEntry'])).toEqual({
            ...Object.fromEntries(
              [1, 2, 3, 4, 5, 6].map((n) => [
                `Widget ${n} standard`,
                [`Product2:Widget ${n}`, STANDARD_BOOK],
              ]),
            ),
            ...Object.fromEntries(
              [1, 2, 3, 6].map((n) => [
                `Widget ${n} custom`,
                [`Product2:Widget ${n}`, 'Pricebook2:Custom'],
              ]),
            ),
            'Widget 4 acme': ['Product2:Widget 4', 'Pricebook2:Acme'],
            'Widget 5 quotes': ['Product2:Widget 5', 'Pricebook2:Quotes'],
          });
          expect(inserted['OpportunityLineItem']).toHaveLength(3);
          expect(inserted['QuoteLineItem'].map((r) => r['PricebookEntryId'])).toEqual([
            'PricebookEntry:Widget 5 quotes',
          ]);
          expect(summary.errors).toEqual([]);
        });

        it('counts what it read of each object as what it wrote of it, the catalog read twice included', async () => {
          // The widget the account supplies and its book are read at their
          // turn, and read again once the lines have named what they price:
          // the second read is what the run clones.
          const { orgDeps, inserted } = accountCatalog(true);

          const summary = await new ForgeExecutor(orgDeps).execute(
            accountGraph(),
            'src',
            'tgt',
            onProgress,
            rooted,
          );

          expect(
            Object.fromEntries(summary.readByObject.map((r) => [r.objectApiName, r.read])),
          ).toEqual(
            Object.fromEntries(
              Object.entries(inserted).map(([object, rows]) => [object, rows.length]),
            ),
          );
          expect(summary.readByObject.find((r) => r.objectApiName === 'Product2')?.read).toBe(6);
          expect(summary.errors).toEqual([]);
        });

        it('says in a dry run what a real run writes of the catalog, once per object', async () => {
          const real = accountCatalog(true);
          await new ForgeExecutor(real.orgDeps).execute(
            accountGraph(),
            'src',
            'tgt',
            () => undefined,
            rooted,
          );
          const { orgDeps, inserted } = accountCatalog(true);

          const summary = await new ForgeExecutor(orgDeps).execute(
            accountGraph(),
            'src',
            'tgt',
            onProgress,
            { ...rooted, dryRun: true },
          );

          expect(inserted).toEqual({});
          const said = progressEvents.map((e) => e.message);
          for (const object of ['Pricebook2', 'Product2', 'PricebookEntry']) {
            expect(said.filter((m) => m.startsWith(`[dry-run] ${object}:`))).toEqual([
              `[dry-run] ${object}: ${real.inserted[object].length} record(s) would be inserted`,
            ]);
          }
          expect(summary.wouldInsertCount).toBe(
            Object.values(real.inserted).reduce((sum, rows) => sum + rows.length, 0),
          );
        });
      });
    });

    describe('a catalog sold under selling models', () => {
      const OPPORTUNITY = '006000000000001AAA';
      const OTHER_OPPORTUNITY = '006000000000002AAA';
      const QUOTE = '0Q0000000000001AAA';
      const STANDARD = '01s000000000001AAA';
      const CUSTOM = '01s000000000002AAA';
      const ONE_TIME = '0jP000000000001AAA';
      const YEARLY = '0jP000000000002AAA';
      const product = (n: number): string => `01t00000000000${n}AAA`;
      /** Each model a number, each book a digit: a price's id says what it is. */
      const MODELS: Record<string, [string | null, number]> = {
        none: [null, 0],
        once: [ONE_TIME, 1],
        yearly: [YEARLY, 2],
      };
      const price = (book: 'standard' | 'custom', model: string, n: number): string =>
        `01u00000000${book === 'standard' ? 1 : 2}${MODELS[model][1]}${n}0AAA`;
      const priceRow = (
        book: 'standard' | 'custom',
        model: string,
        n: number,
        active = true,
      ): FakeRow => ({
        Id: price(book, model, n),
        Name: `Widget ${n} ${book} ${model}`,
        Pricebook2Id: book === 'standard' ? STANDARD : CUSTOM,
        Product2Id: product(n),
        ProductSellingModelId: MODELS[model][0],
        IsActive: active,
      });
      const line = (id: string, n: number, model: string): FakeRow => ({
        Id: id,
        OpportunityId: OPPORTUNITY,
        PricebookEntryId: price('custom', model, n),
        Product2Id: product(n),
      });

      /**
       * A source org sold as a real one was: every widget priced from before
       * selling models, deactivated, and again under the one-time model; the
       * first also sold yearly, and a fourth only on another opportunity.
       */
      function tables(): Record<string, FakeRow[]> {
        return {
          Pricebook2: [
            { Id: STANDARD, Name: 'Standard', IsStandard: true },
            { Id: CUSTOM, Name: 'Custom', IsStandard: false },
          ],
          Product2: [1, 2, 3, 4].map((n) => ({ Id: product(n), Name: `Widget ${n}` })),
          ProductSellingModel: [
            { Id: ONE_TIME, Name: 'One time', SellingModelType: 'OneTime' },
            { Id: YEARLY, Name: 'Yearly', SellingModelType: 'TermDefined' },
          ],
          ProductSellingModelOption: [
            ...[1, 2, 3, 4].map((n) => ({
              Id: `0iO00000000000${n}AAA`,
              Product2Id: product(n),
              ProductSellingModelId: ONE_TIME,
              IsDefault: true,
            })),
            {
              Id: '0iO000000000009AAA',
              Product2Id: product(1),
              ProductSellingModelId: YEARLY,
              IsDefault: false,
            },
          ],
          PricebookEntry: [
            ...[1, 2, 3, 4].flatMap((n) => [
              priceRow('standard', 'none', n, false),
              priceRow('standard', 'once', n),
              priceRow('custom', 'none', n, false),
              priceRow('custom', 'once', n),
            ]),
            priceRow('standard', 'yearly', 1),
            priceRow('custom', 'yearly', 1),
          ],
          Opportunity: [
            { Id: OPPORTUNITY, Name: 'Deal', Pricebook2Id: CUSTOM },
            { Id: OTHER_OPPORTUNITY, Name: 'Other deal', Pricebook2Id: CUSTOM },
          ],
          OpportunityLineItem: [
            line('00k000000000001AAA', 1, 'once'),
            line('00k000000000002AAA', 2, 'once'),
            // Lines from before selling models, on their old prices: one of a
            // widget another line buys under the one-time model.
            line('00k000000000003AAA', 3, 'none'),
            line('00k000000000005AAA', 1, 'none'),
            { ...line('00k000000000004AAA', 4, 'once'), OpportunityId: OTHER_OPPORTUNITY },
          ],
          Quote: [{ Id: QUOTE, Name: 'Offer', OpportunityId: OPPORTUNITY }],
          QuoteLineItem: [
            {
              Id: '0QL000000000001AAA',
              QuoteId: QUOTE,
              PricebookEntryId: price('custom', 'once', 2),
              Product2Id: product(2),
            },
          ],
        };
      }
      const fields: Record<string, FieldInfo[]> = {
        Pricebook2: [idField, text('Name'), { ...text('IsStandard'), createable: false }],
        Product2: [idField, text('Name')],
        ProductSellingModel: [idField, text('Name'), text('SellingModelType')],
        ProductSellingModelOption: [
          idField,
          lookup('Product2Id', 'Product2', true),
          lookup('ProductSellingModelId', 'ProductSellingModel', true),
          text('IsDefault'),
        ],
        PricebookEntry: [
          idField,
          text('Name'),
          lookup('Pricebook2Id', 'Pricebook2', true),
          lookup('Product2Id', 'Product2', true),
          lookup('ProductSellingModelId', 'ProductSellingModel'),
          text('IsActive'),
        ],
        Opportunity: [idField, text('Name'), lookup('Pricebook2Id', 'Pricebook2')],
        OpportunityLineItem: [
          idField,
          lookup('OpportunityId', 'Opportunity', true),
          lookup('PricebookEntryId', 'PricebookEntry'),
          lookup('Product2Id', 'Product2'),
        ],
        Quote: [idField, text('Name'), lookup('OpportunityId', 'Opportunity')],
        QuoteLineItem: [
          idField,
          lookup('QuoteId', 'Quote', true),
          lookup('PricebookEntryId', 'PricebookEntry', true),
          lookup('Product2Id', 'Product2', true),
        ],
      };
      /**
       * The graph two levels around the opportunity, in the order discovery
       * met it: the prices before the products, the quote line before the
       * prices, and nothing walked at the edge — no option, no edge from a
       * price to the quote line or from a product to a price.
       */
      function graph(): ForgeGraph {
        return makeGraph(
          [
            makeNode('Opportunity'),
            makeNode('Pricebook2'),
            makeNode('Quote'),
            makeNode('ProductSellingModel'),
            makeNode('QuoteLineItem'),
            makeNode('PricebookEntry'),
            makeNode('OpportunityLineItem'),
            makeNode('Product2'),
          ],
          [
            edge('Pricebook2', 'Opportunity'),
            edge('Opportunity', 'Quote'),
            { ...edge('Quote', 'QuoteLineItem'), required: true },
            edge('Opportunity', 'OpportunityLineItem'),
            { ...edge('PricebookEntry', 'OpportunityLineItem'), required: true },
            edge('Product2', 'OpportunityLineItem'),
            edge('Pricebook2', 'PricebookEntry'),
          ],
        );
      }

      /**
       * A target that refuses what the platform refuses: a price whose product
       * is not there, a price under a model its product has no option for, a
       * custom price with no standard price of the same product and model,
       * and a line whose price is not there.
       */
      function platform(
        orgDeps: ForgeExecutorDeps,
        inserted: Record<string, Array<Record<string, unknown>>>,
      ) {
        const insert = orgDeps.insertRecords;
        const refused: string[] = [];
        const has = (object: string, test: (row: Record<string, unknown>) => boolean): boolean =>
          (inserted[object] ?? []).some(test);
        orgDeps.insertRecords = async (org, object, rows) => {
          const why = rows.map((row): string | undefined => {
            if (object === 'PricebookEntry') {
              if (!String(row['Product2Id'] ?? '').startsWith('Product2:')) {
                return 'REQUIRED_FIELD_MISSING: Product2Id';
              }
              const model = row['ProductSellingModelId'] ?? null;
              if (
                model !== null &&
                !has(
                  'ProductSellingModelOption',
                  (o) =>
                    o['Product2Id'] === row['Product2Id'] && o['ProductSellingModelId'] === model,
                )
              ) {
                return 'FIELD_INTEGRITY_EXCEPTION: add a product selling model option to the product first';
              }
              if (
                row['Pricebook2Id'] !== STANDARD &&
                !has(
                  'PricebookEntry',
                  (p) =>
                    p['Pricebook2Id'] === STANDARD &&
                    p['Product2Id'] === row['Product2Id'] &&
                    (p['ProductSellingModelId'] ?? null) === model,
                )
              ) {
                return 'STANDARD_PRICE_NOT_DEFINED: no standard price for this product';
              }
            }
            if (
              (object === 'OpportunityLineItem' ||
                object === 'QuoteLineItem' ||
                object === 'OrderItem') &&
              !String(row['PricebookEntryId'] ?? '').startsWith('PricebookEntry:')
            ) {
              return 'FIELD_INTEGRITY_EXCEPTION: must specify pricebook entry id';
            }
            return undefined;
          });
          const accepted = rows.filter((_, i) => why[i] === undefined);
          const results = accepted.length > 0 ? await insert(org, object, accepted) : [];
          let next = 0;
          return rows.map((row, i) => {
            const reason = why[i];
            if (reason === undefined) return results[next++];
            refused.push(`${object} ${String(row['Name'] ?? row['Product2Id'])}: ${reason}`);
            return { id: '', success: false, errors: [reason] };
          });
        };
        return refused;
      }

      it('clones the options of the products it prices, and every price and line sold under them', async () => {
        const { orgDeps, inserted } = fakeOrgs(tables(), fields);
        const refused = platform(orgDeps, inserted);
        const read = recordReads(orgDeps);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          {
            rootRecordId: OPPORTUNITY,
            rootObjectApiName: 'Opportunity',
          },
        );

        expect(refused).toEqual([]);
        // The options of the three products, under the one model the prices
        // name: not the yearly one, not the fourth product's.
        expect(inserted['ProductSellingModelOption']).toEqual(
          [1, 2, 3].map((n) => ({
            Product2Id: `Product2:Widget ${n}`,
            ProductSellingModelId: 'ProductSellingModel:One time',
            IsDefault: true,
          })),
        );
        expect(inserted['ProductSellingModel'].map((r) => r['Name'])).toEqual(['One time']);
        expect([...read['PricebookEntry']].filter((id) => id.endsWith('40AAA'))).toEqual([]);
        // Each custom price with the standard price of its own selling model:
        // the first widget keeps both of its prices, old and one-time.
        expect(inserted['PricebookEntry'].map((r) => r['Name'])).toEqual([
          'Widget 1 standard none',
          'Widget 1 standard once',
          'Widget 2 standard once',
          'Widget 3 standard none',
          'Widget 1 custom none',
          'Widget 1 custom once',
          'Widget 2 custom once',
          'Widget 3 custom none',
        ]);
        expect(inserted['OpportunityLineItem'].map((r) => r['PricebookEntryId'])).toEqual([
          'PricebookEntry:Widget 1 custom once',
          'PricebookEntry:Widget 2 custom once',
          'PricebookEntry:Widget 3 custom none',
          'PricebookEntry:Widget 1 custom none',
        ]);
        expect(inserted['QuoteLineItem'].map((r) => r['PricebookEntryId'])).toEqual([
          'PricebookEntry:Widget 2 custom once',
        ]);
        expect(summary.errors).toEqual([]);
      });

      it('writes products and selling models, their options, prices and lines in that order', async () => {
        const { orgDeps, inserted } = fakeOrgs(tables(), fields);
        platform(orgDeps, inserted);

        await new ForgeExecutor(orgDeps).execute(graph(), 'src', 'tgt', onProgress, {
          rootRecordId: OPPORTUNITY,
          rootObjectApiName: 'Opportunity',
        });

        const written = Object.keys(inserted);
        const before = (a: string, b: string): boolean => written.indexOf(a) < written.indexOf(b);
        expect(before('Product2', 'ProductSellingModelOption')).toBe(true);
        expect(before('ProductSellingModel', 'ProductSellingModelOption')).toBe(true);
        expect(before('ProductSellingModelOption', 'PricebookEntry')).toBe(true);
        expect(before('PricebookEntry', 'QuoteLineItem')).toBe(true);
        expect(before('PricebookEntry', 'OpportunityLineItem')).toBe(true);
      });

      it('joins the products its lines name to their selling models when the account supplies products', async () => {
        // A product naming the opportunity's account as its supplier is a
        // child of the account. Read under the account at its turn, and not
        // again, the products were the ones the account supplies — none here —
        // so no option joined a product the prices name to its selling model,
        // every price was refused for want of its product, and every line went
        // with them.
        const { orgDeps, inserted } = fakeOrgs(
          {
            ...tables(),
            Account: [{ Id: ACCOUNT, Name: 'Acme' }],
            Opportunity: tables().Opportunity.map((row) => ({ ...row, AccountId: ACCOUNT })),
            Product2: tables().Product2.map((row) => ({ ...row, Supplier__c: null })),
          },
          {
            ...fields,
            Account: [idField, text('Name')],
            Opportunity: [...fields['Opportunity'], lookup('AccountId', 'Account')],
            Product2: [...fields['Product2'], lookup('Supplier__c', 'Account')],
          },
        );
        const refused = platform(orgDeps, inserted);
        const walked = graph();
        walked.nodes.push(makeNode('Account'));
        walked.edges.push(edge('Account', 'Opportunity'), edge('Account', 'Product2'));

        const summary = await new ForgeExecutor(orgDeps).execute(walked, 'src', 'tgt', onProgress, {
          rootRecordId: OPPORTUNITY,
          rootObjectApiName: 'Opportunity',
        });

        expect(refused).toEqual([]);
        expect(inserted['ProductSellingModelOption']).toHaveLength(3);
        expect(inserted['PricebookEntry']).toHaveLength(8);
        expect(inserted['OpportunityLineItem']).toHaveLength(4);
        expect(inserted['QuoteLineItem']).toHaveLength(1);
        expect(summary.errors).toEqual([]);
      });

      it('reads none of the prices sold under a selling model its lines name', async () => {
        // A deeper graph walks the selling model, whose prices are its
        // children, and a quote line names it before any price is read. Read
        // as any parent in scope is, the one-time model of a real org would
        // have brought its 275 prices.
        const { orgDeps, inserted } = fakeOrgs(
          {
            ...tables(),
            QuoteLineItem: tables().QuoteLineItem.map((row) => ({
              ...row,
              ProductSellingModelId: ONE_TIME,
            })),
          },
          {
            ...fields,
            QuoteLineItem: [
              ...fields.QuoteLineItem,
              lookup('ProductSellingModelId', 'ProductSellingModel'),
            ],
          },
        );
        platform(orgDeps, inserted);
        const read = recordReads(orgDeps);
        const walked = graph();
        walked.edges.push(edge('ProductSellingModel', 'PricebookEntry'));

        const summary = await new ForgeExecutor(orgDeps).execute(walked, 'src', 'tgt', onProgress, {
          rootRecordId: OPPORTUNITY,
          rootObjectApiName: 'Opportunity',
        });

        // Nothing of the fourth widget, sold under the same model.
        expect([...read['PricebookEntry']].filter((id) => id.endsWith('40AAA'))).toEqual([]);
        expect(inserted['PricebookEntry']).toHaveLength(8);
        expect(summary.errors).toEqual([]);
      });

      it('clones the catalog in a run that reads whole tables, options and order included', async () => {
        // No record to start from: every object is read whole and written as
        // soon as it is read, in one order settled before the first read. A
        // quote line met before the prices, the prices before their products,
        // and no option in the graph: every price was refused.
        const { orgDeps, inserted } = fakeOrgs(tables(), fields);
        const everyRow = tables();
        const query = orgDeps.queryRecords;
        orgDeps.queryRecords = async (org, soql, onTruncated) => {
          const whole = /^SELECT .+ FROM (\w+)$/.exec(soql);
          return whole ? [...(everyRow[whole[1]] ?? [])] : query(org, soql, onTruncated);
        };
        const refused = platform(orgDeps, inserted);
        const graph = makeGraph(
          [
            makeNode('Quote'),
            makeNode('QuoteLineItem'),
            makeNode('Pricebook2'),
            makeNode('PricebookEntry'),
            makeNode('Product2'),
            makeNode('ProductSellingModel'),
          ],
          [
            { ...edge('Quote', 'QuoteLineItem'), required: true },
            edge('Pricebook2', 'PricebookEntry'),
          ],
        );

        const summary = await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress);

        expect(refused).toEqual([]);
        expect(inserted['ProductSellingModelOption']).toHaveLength(5);
        expect(inserted['PricebookEntry']).toHaveLength(18);
        expect(inserted['QuoteLineItem'].map((r) => r['PricebookEntryId'])).toEqual([
          'PricebookEntry:Widget 2 custom once',
        ]);
        const written = Object.keys(inserted);
        expect(written.indexOf('ProductSellingModelOption')).toBeLessThan(
          written.indexOf('PricebookEntry'),
        );
        expect(written.indexOf('PricebookEntry')).toBeLessThan(written.indexOf('QuoteLineItem'));
        expect(summary.errors).toEqual([]);
      });

      it('names the options it would write in a dry run', async () => {
        const { orgDeps, inserted } = fakeOrgs(tables(), fields);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          {
            rootRecordId: OPPORTUNITY,
            rootObjectApiName: 'Opportunity',
            dryRun: true,
          },
        );

        expect(inserted).toEqual({});
        expect(progressEvents.map((e) => e.message)).toContain(
          '[dry-run] ProductSellingModelOption: 3 record(s) would be inserted',
        );
        expect(summary.errors).toEqual([]);
      });

      describe('when discovery stopped before the catalog', () => {
        /**
         * The graph the default cap of fifty objects left around an
         * opportunity: its book, its quote and its lines, and none of the
         * prices they name. Discovery drew the edge from a price to the line
         * whose lookups it walked, and never reached the price.
         */
        function cappedGraph(): ForgeGraph {
          return makeGraph(
            [
              makeNode('Opportunity'),
              makeNode('Pricebook2'),
              makeNode('Quote'),
              makeNode('QuoteLineItem'),
              makeNode('OpportunityLineItem'),
            ],
            [
              edge('Pricebook2', 'Opportunity'),
              edge('Opportunity', 'Quote'),
              { ...edge('Quote', 'QuoteLineItem'), required: true },
              edge('Opportunity', 'OpportunityLineItem'),
              { ...edge('PricebookEntry', 'OpportunityLineItem'), required: true },
            ],
          );
        }
        const rooted = { rootRecordId: OPPORTUNITY, rootObjectApiName: 'Opportunity' };

        it('clones the prices its lines use, with their products, selling models and options', async () => {
          // Run for real at the default cap: the clone read three line items
          // and not one of their prices, and a real run would have sent every
          // line without the price the platform refuses a line without.
          const { orgDeps, inserted } = fakeOrgs(tables(), fields);
          const refused = platform(orgDeps, inserted);

          const summary = await new ForgeExecutor(orgDeps).execute(
            cappedGraph(),
            'src',
            'tgt',
            onProgress,
            rooted,
          );

          expect(refused).toEqual([]);
          expect(inserted['Product2'].map((r) => r['Name'])).toEqual([
            'Widget 1',
            'Widget 2',
            'Widget 3',
          ]);
          expect(inserted['ProductSellingModel'].map((r) => r['Name'])).toEqual(['One time']);
          expect(inserted['ProductSellingModelOption']).toHaveLength(3);
          expect(inserted['PricebookEntry'].map((r) => r['Name'])).toEqual([
            'Widget 1 standard none',
            'Widget 1 standard once',
            'Widget 2 standard once',
            'Widget 3 standard none',
            'Widget 1 custom none',
            'Widget 1 custom once',
            'Widget 2 custom once',
            'Widget 3 custom none',
          ]);
          expect(inserted['OpportunityLineItem'].map((r) => r['PricebookEntryId'])).toEqual([
            'PricebookEntry:Widget 1 custom once',
            'PricebookEntry:Widget 2 custom once',
            'PricebookEntry:Widget 3 custom none',
            'PricebookEntry:Widget 1 custom none',
          ]);
          expect(inserted['QuoteLineItem'].map((r) => r['PricebookEntryId'])).toEqual([
            'PricebookEntry:Widget 2 custom once',
          ]);
          // The standard book is matched, as in a graph that reached it.
          expect(inserted['Pricebook2'].map((r) => r['Name'])).toEqual(['Custom']);
          expect(summary.errors).toEqual([]);
        });

        it('says in a dry run the prices, products and selling models a real run writes', async () => {
          const { orgDeps, inserted } = fakeOrgs(tables(), fields);

          const summary = await new ForgeExecutor(orgDeps).execute(
            cappedGraph(),
            'src',
            'tgt',
            onProgress,
            { ...rooted, dryRun: true },
          );

          expect(inserted).toEqual({});
          expect(progressEvents.map((e) => e.message)).toEqual(
            expect.arrayContaining([
              '[dry-run] PricebookEntry: 8 record(s) would be inserted',
              '[dry-run] Product2: 3 record(s) would be inserted',
              '[dry-run] ProductSellingModel: 1 record(s) would be inserted',
              '[dry-run] ProductSellingModelOption: 3 record(s) would be inserted',
            ]),
          );
          expect(summary.errors).toEqual([]);
        });

        it('leaves out an object of the catalog the graph holds and leaves out', async () => {
          // Prices unchecked, or empty in the whole org: the selling models
          // are reached through them alone, and stay out with them.
          const { orgDeps } = fakeOrgs(tables(), fields);
          const read = recordReads(orgDeps);
          const withoutPrices = cappedGraph();
          withoutPrices.nodes.push(makeNode('PricebookEntry', { included: false }));

          await new ForgeExecutor(orgDeps).execute(withoutPrices, 'src', 'tgt', onProgress, {
            ...rooted,
            dryRun: true,
          });

          expect(read['PricebookEntry']).toBeUndefined();
          expect(read['ProductSellingModel']).toBeUndefined();
          // A quote line cannot be written without its product, which comes:
          // read, as the catalog is, by what the lines name.
          expect(read['Product2']).toEqual(new Set([1, 2, 3].map(product)));
        });

        it('brings nothing of the catalog through a lookup that can name several objects', async () => {
          // A feed item's parent can be a product or a price, and says nothing
          // of which: its rows name what they name.
          const feedParent: FieldInfo = {
            ...lookup('ParentId', 'Opportunity', true),
            referenceTo: ['Opportunity', 'Product2', 'PricebookEntry'],
          };
          const { orgDeps } = fakeOrgs(
            {
              ...tables(),
              FeedItem: [{ Id: '0D5000000000001AAA', Body: 'On the deal', ParentId: OPPORTUNITY }],
            },
            { ...fields, FeedItem: [idField, text('Body'), feedParent] },
          );
          const read = recordReads(orgDeps);
          const graph = makeGraph(
            [makeNode('Opportunity'), makeNode('FeedItem')],
            [{ ...edge('Opportunity', 'FeedItem'), type: 'master-detail', required: true }],
          );

          await new ForgeExecutor(orgDeps).execute(graph, 'src', 'tgt', onProgress, {
            ...rooted,
            dryRun: true,
          });

          expect(Object.keys(read).sort()).toEqual(['FeedItem', 'Opportunity']);
          expect(
            progressEvents.filter(
              (e) => e.objectName !== 'Opportunity' && e.objectName !== 'FeedItem',
            ),
          ).toEqual([]);
        });

        it('prices the items it brings for an order it activates, when no other record names the catalog', async () => {
          // The items come for the order's status, and a price is what an
          // item cannot be written without: the fourth widget is sold on no
          // line of this opportunity, only on its order.
          const ORDER = '801000000000001AAA';
          const { orgDeps, inserted, updated } = fakeOrgs(
            {
              ...tables(),
              Order: [{ Id: ORDER, Name: 'Order', OpportunityId: OPPORTUNITY, Status: 'Live' }],
              OrderItem: [
                {
                  Id: '802000000000001AAA',
                  Name: 'Item',
                  OrderId: ORDER,
                  PricebookEntryId: price('custom', 'once', 4),
                  Product2Id: product(4),
                },
              ],
            },
            {
              ...fields,
              Order: [
                idField,
                text('Name'),
                lookup('OpportunityId', 'Opportunity'),
                text('Status'),
              ],
              OrderItem: [
                idField,
                text('Name'),
                lookup('OrderId', 'Order', true),
                lookup('PricebookEntryId', 'PricebookEntry', true),
                lookup('Product2Id', 'Product2'),
              ],
            },
          );
          const refused = platform(orgDeps, inserted);
          const query = orgDeps.queryRecords;
          orgDeps.queryRecords = async (org, soql, onTruncated) =>
            soql === 'SELECT ApiName, StatusCode FROM OrderStatus'
              ? [
                  { ApiName: 'Open', StatusCode: 'Draft' },
                  { ApiName: 'Live', StatusCode: 'Activated' },
                ]
              : query(org, soql, onTruncated);
          const graph = makeGraph(
            [makeNode('Opportunity'), makeNode('Order')],
            [edge('Opportunity', 'Order')],
          );

          const summary = await new ForgeExecutor(orgDeps).execute(
            graph,
            'src',
            'tgt',
            onProgress,
            rooted,
          );

          expect(refused).toEqual([]);
          expect(inserted['Product2'].map((r) => r['Name'])).toEqual(['Widget 4']);
          expect(inserted['ProductSellingModelOption']).toHaveLength(1);
          expect(inserted['PricebookEntry'].map((r) => r['Name'])).toEqual([
            'Widget 4 standard once',
            'Widget 4 custom once',
          ]);
          expect(inserted['OrderItem']).toEqual([
            {
              Name: 'Item',
              OrderId: 'Order:Order',
              PricebookEntryId: 'PricebookEntry:Widget 4 custom once',
              Product2Id: 'Product2:Widget 4',
            },
          ]);
          expect(updated).toContainEqual({
            object: 'Order',
            rows: [{ Id: 'Order:Order', Status: 'Live' }],
          });
          expect(summary.errors).toEqual([]);
        });
      });
    });

    describe('a required lookup that can point at several objects', () => {
      const OPPORTUNITY = '006000000000001AAA';
      const QUOTE = '0Q0000000000001AAA';
      const OTHER_QUOTE = '0Q0000000000002AAA';
      const DEAL_POST = '0D5000000000001AAA';
      const QUOTE_POST = '0D5000000000002AAA';
      /** The source org's key prefixes, as the describe the run holds of each object gives them. */
      const KEY_PREFIXES: Record<string, string> = {
        Account: '001',
        Opportunity: '006',
        Quote: '0Q0',
        QuoteLineItem: '0QL',
        FeedItem: '0D5',
        FeedComment: '0D7',
      };
      /** A feed item's parent: it may not be left empty, and it can be one of several objects. */
      const feedParent: FieldInfo = {
        name: 'ParentId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Account', 'Opportunity', 'Quote'],
        nillable: false,
      };
      const fields: Record<string, FieldInfo[]> = {
        Opportunity: [idField, text('Name')],
        Quote: [idField, text('Name'), lookup('OpportunityId', 'Opportunity')],
        QuoteLineItem: [idField, text('Description'), lookup('QuoteId', 'Quote', true)],
        FeedItem: [idField, text('Body'), feedParent],
        FeedComment: [idField, text('CommentBody'), lookup('FeedItemId', 'FeedItem', true)],
      };
      const tables = (): Record<string, FakeRow[]> => ({
        Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal' }],
        Quote: [
          { Id: QUOTE, Name: 'First', OpportunityId: OPPORTUNITY },
          { Id: OTHER_QUOTE, Name: 'Second', OpportunityId: OPPORTUNITY },
        ],
        QuoteLineItem: [{ Id: '0QL000000000001AAA', Description: 'Line', QuoteId: QUOTE }],
        FeedItem: [
          { Id: DEAL_POST, Body: 'On the deal', ParentId: OPPORTUNITY },
          { Id: QUOTE_POST, Body: 'On the first quote', ParentId: QUOTE },
          { Id: '0D5000000000003AAA', Body: 'On the second quote', ParentId: OTHER_QUOTE },
        ],
        FeedComment: [{ Id: '0D7000000000001AAA', CommentBody: 'Reply', FeedItemId: QUOTE_POST }],
      });
      /**
       * The graph discovery draws around an opportunity. A feed item's parent
       * gets an edge from each object it can name, master-detail because the
       * parent's side deletes its feed with it, and required because the field
       * is: what the target describes of a real org.
       */
      const graph = (): ForgeGraph =>
        makeGraph(
          [
            makeNode('Opportunity'),
            makeNode('Quote'),
            makeNode('QuoteLineItem'),
            makeNode('FeedItem'),
            makeNode('FeedComment'),
          ],
          [
            edge('Opportunity', 'Quote'),
            { ...edge('Quote', 'QuoteLineItem'), type: 'master-detail', required: true },
            { ...edge('Opportunity', 'FeedItem'), type: 'master-detail', required: true },
            { ...edge('Quote', 'FeedItem'), type: 'master-detail', required: true },
            { ...edge('FeedItem', 'FeedComment'), type: 'master-detail', required: true },
          ],
        );
      const scoped = { rootRecordId: OPPORTUNITY, rootObjectApiName: 'Opportunity' };

      /**
       * The fake orgs of `tables`, whose target refuses the quotes named, and
       * which describe each object with its key prefix.
       */
      function orgs(refusedQuotes: string[], rows: Record<string, FakeRow[]> = tables()) {
        const run = fakeOrgs(rows, fields);
        const insert = run.orgDeps.insertRecords;
        run.orgDeps.insertRecords = async (org, object, records) => {
          const results = await insert(org, object, records);
          if (object !== 'Quote') return results;
          return results.map((result, i) =>
            refusedQuotes.includes(String(records[i]['Name']))
              ? {
                  id: '',
                  success: false,
                  errors: ['INVALID_CROSS_REFERENCE_KEY: invalid cross reference id'],
                }
              : result,
          );
        };
        run.orgDeps.describeObject = async (_org, object) => ({
          keyPrefix: KEY_PREFIXES[object] ?? null,
          recordTypes: [],
        });
        return run;
      }

      const heldUnderQuotes = (count: number, why: string) => ({
        objectApiName: 'FeedItem',
        stage: 'scope',
        failedCount: count,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: `ParentId → Quote (${count} record${count === 1 ? '' : 's'})`,
            messages: [
              `Not written: ParentId may not be left empty, and the Quote it points at ${why}`,
            ],
          },
        ],
      });

      it('writes the feed item of the opportunity, and holds back and names those of the quotes the target refused', async () => {
        // Run for real: every quote of the opportunity refused, and not one
        // feed item written, the opportunity's own among them — the parent of
        // a feed item can be any of 216 objects, and one of them had failed.
        const { orgDeps, inserted } = orgs(['First', 'Second']);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          scoped,
        );

        expect(inserted['FeedItem']).toEqual([
          { Body: 'On the deal', ParentId: 'Opportunity:Deal' },
        ]);
        expect(summary.errors).toContainEqual(heldUnderQuotes(2, 'failed in this run.'));
        // The two quotes the target refused, and the two feed items under them.
        expect(summary.failedCount).toBe(4);
        expect(progressEvents.filter((e) => e.objectName === 'FeedItem').pop()).toMatchObject({
          status: 'done',
          message:
            'Completed FeedItem: 1 succeeded, 0 failed, 2 not written for want of their parent',
        });
      });

      it('still skips an object whose lookup at the failed object names that object alone', async () => {
        const { orgDeps, inserted } = orgs(['First', 'Second']);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          scoped,
        );

        expect(inserted['QuoteLineItem']).toBeUndefined();
        expect(summary.skippedCount).toBe(1);
        expect(
          progressEvents.find((e) => e.objectName === 'QuoteLineItem' && e.status === 'skipped')
            ?.message,
        ).toBe('Skipped QuoteLineItem (parent failed)');
      });

      it('holds back the feed item of the one quote refused, and writes that of the quote written', async () => {
        // One quote of two refused leaves Quote short of failing as a whole:
        // its other quote is there to post on.
        const { orgDeps, inserted } = orgs(['First']);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          scoped,
        );

        expect(inserted['FeedItem']).toEqual([
          { Body: 'On the deal', ParentId: 'Opportunity:Deal' },
          { Body: 'On the second quote', ParentId: 'Quote:Second' },
        ]);
        expect(summary.errors).toContainEqual(heldUnderQuotes(1, 'was not written by this run.'));
      });

      it('holds a feed item back whole when every row points at a parent not written, and skips what cannot do without it', async () => {
        const rows = tables();
        rows['FeedItem'] = rows['FeedItem'].filter((row) => row['ParentId'] !== OPPORTUNITY);
        const { orgDeps, inserted } = orgs(['First', 'Second'], rows);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          scoped,
        );

        // Not even an empty call.
        expect(inserted['FeedItem']).toBeUndefined();
        expect(summary.errors).toContainEqual(heldUnderQuotes(2, 'failed in this run.'));
        expect(progressEvents.filter((e) => e.objectName === 'FeedItem').pop()).toMatchObject({
          status: 'error',
          message:
            'Held back FeedItem, nothing written: every record points at a parent this run ' +
            'did not write. Objects that cannot be written without it will be skipped.',
        });
        expect(inserted['FeedComment']).toBeUndefined();
        expect(
          progressEvents.find((e) => e.objectName === 'FeedComment' && e.status === 'skipped')
            ?.message,
        ).toBe('Skipped FeedComment (parent failed)');
      });

      it('decides row by row in a run of whole tables, telling the parents apart by the ids it read', async () => {
        // Written as soon as it is read, a node is asked about its parents
        // before its fields are: the graph's edges alone said a quote had
        // failed. And without `describeObject` the key prefixes come from the
        // rows read.
        const { orgDeps, inserted } = orgs(['First', 'Second']);
        delete orgDeps.describeObject;
        const everyRow = tables();
        orgDeps.queryRecords = async (_org, soql) => {
          const object = /^SELECT .+ FROM (\w+)$/.exec(soql)?.[1] ?? '';
          return (everyRow[object] ?? []).map((row) => ({ ...row }));
        };

        const summary = await new ForgeExecutor(orgDeps).execute(graph(), 'src', 'tgt', onProgress);

        expect(inserted['FeedItem']).toEqual([
          { Body: 'On the deal', ParentId: 'Opportunity:Deal' },
        ]);
        expect(summary.errors).toContainEqual(heldUnderQuotes(2, 'failed in this run.'));
        expect(
          progressEvents.some((e) => e.objectName === 'FeedItem' && e.status === 'skipped'),
        ).toBe(false);
      });

      it('tells the object of a parent it read nothing of by the key prefix its describe gives', async () => {
        // The quotes' read failed: no id of a quote was read, and the prefix
        // comes from the describe the run holds of Quote.
        const { orgDeps, inserted } = orgs([]);
        const everyRow = tables();
        orgDeps.queryRecords = async (_org, soql) => {
          const object = /^SELECT .+ FROM (\w+)$/.exec(soql)?.[1] ?? '';
          if (object === 'Quote') throw new Error('QUERY_TIMEOUT: the query ran for too long');
          return (everyRow[object] ?? []).map((row) => ({ ...row }));
        };

        const summary = await new ForgeExecutor(orgDeps).execute(graph(), 'src', 'tgt', onProgress);

        expect(inserted['FeedItem']).toEqual([
          { Body: 'On the deal', ParentId: 'Opportunity:Deal' },
        ]);
        expect(summary.errors).toContainEqual(heldUnderQuotes(2, 'failed in this run.'));
      });

      it('copies the missing parent of a feed item from the object its id belongs to', async () => {
        // The quotes left out of the clone, the feed items posted on them
        // point at parents the run does not write, which expansion copies in.
        // Looked for among the accounts — the first object `ParentId` names —
        // a quote was never found, and its feed item went in without it.
        const { orgDeps, inserted } = orgs([]);
        const everyRow = tables();
        orgDeps.queryRecords = async (_org, soql) => {
          const whole = /^SELECT .+ FROM (\w+)$/.exec(soql)?.[1];
          return whole
            ? (everyRow[whole] ?? []).map((row) => ({ ...row }))
            : selectRows(everyRow, soql);
        };
        const described: string[] = [];
        const describeFields = orgDeps.describeFields;
        orgDeps.describeFields = async (org, object) => {
          described.push(object);
          return describeFields(org, object);
        };
        const describeObject = orgDeps.describeObject;
        orgDeps.describeObject = async (org, object) => {
          described.push(object);
          return describeObject!(org, object);
        };
        const withoutQuotes = graph();
        withoutQuotes.nodes = withoutQuotes.nodes.map((n) =>
          n.objectApiName === 'Quote' || n.objectApiName === 'QuoteLineItem'
            ? { ...n, included: false }
            : n,
        );

        const summary = await new ForgeExecutor(orgDeps).execute(
          withoutQuotes,
          'src',
          'tgt',
          onProgress,
          { expandOrphanParents: true },
        );

        expect(inserted['Quote']).toEqual([{ Name: 'First' }, { Name: 'Second' }]);
        expect(inserted['FeedItem']).toEqual([
          { Body: 'On the deal', ParentId: 'Opportunity:Deal' },
          { Body: 'On the first quote', ParentId: 'Quote:First' },
          { Body: 'On the second quote', ParentId: 'Quote:Second' },
        ]);
        // The objects of the graph are asked first, and the one found ends
        // the search: no account was ever described.
        expect(described).not.toContain('Account');
        expect(
          summary.errors.find((e) => e.objectApiName === '__expandOrphanParents__'),
        ).toBeUndefined();
      });
    });

    describe('an id a lookup naming several objects holds', () => {
      const OPPORTUNITY = '006000000000001AAA';
      const QUOTE = '0Q0000000000001AAA';
      const PROCEDURE = '0mc000000000001AAA';
      /** The source org's key prefixes, as the describe the run holds of each object gives them. */
      const KEY_PREFIXES: Record<string, string> = {
        Opportunity: '006',
        Quote: '0Q0',
        EmailMessage: '02s',
        CalculationProcedure: '0mc',
        CalculationProcedureVersion: '0md',
      };
      /** What an email is related to: nearly any object, a calculation procedure among them. */
      const relatedTo: FieldInfo = {
        ...lookup('RelatedToId', 'Opportunity'),
        referenceTo: ['Opportunity', 'Quote', 'CalculationProcedure'],
      };
      const fields: Record<string, FieldInfo[]> = {
        Opportunity: [idField, text('Name')],
        Quote: [idField, text('Name'), lookup('OpportunityId', 'Opportunity')],
        EmailMessage: [idField, text('Subject'), relatedTo],
        CalculationProcedure: [idField, text('Name')],
        CalculationProcedureVersion: [
          idField,
          text('Name'),
          lookup('CalculationProcedureId', 'CalculationProcedure', true),
        ],
      };
      const tables = (): Record<string, FakeRow[]> => ({
        Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal' }],
        Quote: [{ Id: QUOTE, Name: 'Offer', OpportunityId: OPPORTUNITY }],
        EmailMessage: [{ Id: '02s000000000001AAA', Subject: 'The offer', RelatedToId: QUOTE }],
        CalculationProcedure: [{ Id: PROCEDURE, Name: 'Discounts' }],
        CalculationProcedureVersion: [
          { Id: '0md000000000001AAA', Name: 'Discounts 1', CalculationProcedureId: PROCEDURE },
        ],
      });
      /** The graph discovery draws around the opportunity: each object the email names is its parent. */
      const graph = (): ForgeGraph =>
        makeGraph(
          [
            makeNode('Opportunity'),
            makeNode('Quote'),
            makeNode('EmailMessage'),
            makeNode('CalculationProcedure'),
            makeNode('CalculationProcedureVersion'),
          ],
          [
            edge('Opportunity', 'Quote'),
            edge('Opportunity', 'EmailMessage'),
            edge('Quote', 'EmailMessage'),
            edge('CalculationProcedure', 'EmailMessage'),
            { ...edge('CalculationProcedure', 'CalculationProcedureVersion'), required: true },
          ],
        );
      const scoped = { rootRecordId: OPPORTUNITY, rootObjectApiName: 'Opportunity' };

      /** The fake orgs, which describe each object with its key prefix, and the statements sent. */
      function orgs() {
        const run = fakeOrgs(tables(), fields);
        run.orgDeps.describeObject = async (_org, object) => ({
          keyPrefix: KEY_PREFIXES[object] ?? null,
          recordTypes: [],
        });
        const sent: string[] = [];
        const query = run.orgDeps.queryRecords;
        run.orgDeps.queryRecords = async (org, soql, onTruncated) => {
          sent.push(soql);
          return query(org, soql, onTruncated);
        };
        return { ...run, sent };
      }
      const askedOfProcedures = (sent: string[]): string[] =>
        sent.filter((soql) => /FROM CalculationProcedure(Version)? /.test(soql));

      it('asks no object for an id its key prefix gives to another, in a dry run', async () => {
        // Run for real, the quote an email was related to was asked of every
        // object the email's lookup could name — a calculation procedure, a
        // document template, an expression set — and of their children: some
        // forty statements a run, each bound to come back empty.
        const { orgDeps, sent } = orgs();

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          {
            ...scoped,
            dryRun: true,
          },
        );

        expect(askedOfProcedures(sent)).toEqual([]);
        expect(progressEvents.map((e) => e.message)).toEqual(
          expect.arrayContaining([
            '[dry-run] EmailMessage: 1 record(s) would be inserted',
            'Skipped CalculationProcedure (out of scope: no parent in cache and not the root)',
          ]),
        );
        expect(summary.errors).toEqual([]);
      });

      it('writes the email against the quote it is related to, and nothing of the procedures', async () => {
        const { orgDeps, inserted, sent } = orgs();

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          scoped,
        );

        expect(inserted['EmailMessage']).toEqual([
          { Subject: 'The offer', RelatedToId: 'Quote:Offer' },
        ]);
        expect(inserted['CalculationProcedure']).toBeUndefined();
        expect(askedOfProcedures(sent)).toEqual([]);
        expect(summary.errors).toEqual([]);
      });

      it('tells the object of an id by the rows read of it when no describe gives its prefix', async () => {
        // A dry run keeps none of the rows it reads, and asked of the
        // describe alone, the prefixes of a source that gives none are unknown.
        const { orgDeps, sent } = orgs();
        delete orgDeps.describeObject;

        await new ForgeExecutor(orgDeps).execute(graph(), 'src', 'tgt', onProgress, {
          ...scoped,
          dryRun: true,
        });

        expect(askedOfProcedures(sent)).toEqual([]);
      });
    });

    describe('a feed item the platform writes itself', () => {
      const OPPORTUNITY = '006000000000001AAA';
      const POST = '0D5000000000001AAA';
      const CHANGE = '0D5000000000002AAA';
      const fields: Record<string, FieldInfo[]> = {
        Opportunity: [idField, text('Name')],
        FeedItem: [
          idField,
          text('Body'),
          text('Type'),
          {
            ...lookup('ParentId', 'Opportunity', true),
            referenceTo: ['Account', 'Opportunity'],
          },
        ],
        FeedComment: [idField, text('CommentBody'), lookup('FeedItemId', 'FeedItem', true)],
      };
      const tables = (): Record<string, FakeRow[]> => ({
        Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal' }],
        FeedItem: [
          { Id: POST, Body: 'Kick-off', Type: 'TextPost', ParentId: OPPORTUNITY },
          { Id: CHANGE, Body: null, Type: 'TrackedChange', ParentId: OPPORTUNITY },
        ],
        FeedComment: [
          { Id: '0D7000000000001AAA', CommentBody: 'On the post', FeedItemId: POST },
          { Id: '0D7000000000002AAA', CommentBody: 'On the change', FeedItemId: CHANGE },
        ],
      });
      const graph = (): ForgeGraph =>
        makeGraph(
          [makeNode('Opportunity'), makeNode('FeedItem'), makeNode('FeedComment')],
          [
            { ...edge('Opportunity', 'FeedItem'), type: 'master-detail', required: true },
            { ...edge('FeedItem', 'FeedComment'), type: 'master-detail', required: true },
          ],
        );
      const scoped = { rootRecordId: OPPORTUNITY, rootObjectApiName: 'Opportunity' };

      /** The fake orgs of `tables`, whose target refuses a tracked change as the platform does. */
      function orgs(described: Record<string, FieldInfo[]> = fields, rows = tables()) {
        const run = fakeOrgs(rows, described);
        const insert = run.orgDeps.insertRecords;
        run.orgDeps.insertRecords = async (org, object, records) => {
          const results = await insert(org, object, records);
          return results.map((result, i) =>
            object === 'FeedItem' && records[i]['Type'] === 'TrackedChange'
              ? {
                  id: '',
                  success: false,
                  errors: [
                    'INVALID_FIELD: Cannot directly insert FeedItem with type TrackedChange',
                  ],
                }
              : result,
          );
        };
        return run;
      }

      const leftOut = {
        objectApiName: 'FeedItem',
        stage: 'scope',
        failedCount: 0,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: 'Type=TrackedChange (1 record)',
            messages: [
              'Not written: the platform writes each tracked change itself, and refuses one a copy sends.',
            ],
          },
        ],
      };

      it('leaves out a tracked change, which the platform refuses from a copy, and says so', async () => {
        // Run for real, the clone of an opportunity sent its one feed item, a
        // tracked change, and the platform refused it: "Cannot directly
        // insert FeedItem with type TrackedChange".
        const { orgDeps, inserted } = orgs();

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          scoped,
        );

        expect(inserted['FeedItem']).toEqual([
          { Body: 'Kick-off', Type: 'TextPost', ParentId: 'Opportunity:Deal' },
        ]);
        expect(summary.failedCount).toBe(0);
        expect(summary.errors).toEqual([leftOut]);
        expect(progressEvents.filter((e) => e.objectName === 'FeedItem').pop()).toMatchObject({
          status: 'done',
          message:
            'Completed FeedItem: 1 succeeded, 0 failed, 1 tracked change left out: the platform writes them itself',
        });
      });

      it('reads nothing that hangs from a tracked change it leaves out', async () => {
        // A comment cannot go in without the feed item it answers.
        const { orgDeps, inserted } = orgs();
        const read = recordReads(orgDeps);

        await new ForgeExecutor(orgDeps).execute(graph(), 'src', 'tgt', onProgress, scoped);

        expect([...(read['FeedComment'] ?? [])]).toEqual(['0D7000000000001AAA']);
        expect(inserted['FeedComment']).toEqual([
          { CommentBody: 'On the post', FeedItemId: 'FeedItem:1' },
        ]);
      });

      it('says in a dry run that a tracked change would be left out, and counts it among nothing inserted', async () => {
        const { orgDeps } = orgs();

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          { ...scoped, dryRun: true },
        );

        expect(
          progressEvents.find((e) => e.objectName === 'FeedItem' && e.status === 'done')?.message,
        ).toBe(
          '[dry-run] FeedItem: 1 record(s) would be inserted, 1 tracked change left out: the platform writes them itself',
        );
        // The opportunity, the post and the comment on it.
        expect(summary.wouldInsertCount).toBe(3);
        expect(summary.errors).toEqual([leftOut]);
      });

      describe('a comment on one', () => {
        // As the org describes it: a comment's feed item may be a feed item or
        // the feed of any object, and the comment names the record the feed
        // item is on, which it cannot set.
        const described: Record<string, FieldInfo[]> = {
          ...fields,
          FeedComment: [
            idField,
            text('CommentBody'),
            {
              ...lookup('FeedItemId', 'FeedItem', true),
              referenceTo: ['FeedItem', 'OpportunityFeed'],
            },
            {
              ...lookup('ParentId', 'Opportunity'),
              referenceTo: ['Account', 'Opportunity'],
              createable: false,
            },
          ],
        };
        const withParents = (rows: Record<string, FakeRow[]>): Record<string, FakeRow[]> => ({
          ...rows,
          FeedComment: (rows['FeedComment'] ?? []).map((row) => ({
            ...row,
            ParentId: OPPORTUNITY,
          })),
        });
        const KEY_PREFIXES: Record<string, string> = {
          Opportunity: '006',
          FeedItem: '0D5',
          FeedComment: '0D7',
        };
        /** The graph discovery draws: a comment hangs from its feed item and from the record. */
        const describedGraph = (): ForgeGraph => {
          const drawn = graph();
          drawn.edges.push(edge('Opportunity', 'FeedComment'));
          return drawn;
        };

        /**
         * The fake orgs, read whole when a run reads whole tables, telling each
         * object's key prefix as a describe does.
         */
        function describedOrgs(rows = withParents(tables())) {
          const run = orgs(described, rows);
          run.orgDeps.queryRecords = async (_org, soql) => {
            const whole = /^SELECT .+ FROM (\w+)$/.exec(soql)?.[1];
            return whole ? (rows[whole] ?? []).map((row) => ({ ...row })) : selectRows(rows, soql);
          };
          run.orgDeps.describeObject = async (_org, object) => ({
            keyPrefix: KEY_PREFIXES[object] ?? null,
            recordTypes: [],
          });
          return run;
        }

        const commentLeftOut = {
          objectApiName: 'FeedComment',
          stage: 'scope',
          failedCount: 0,
          attemptedCount: 0,
          samples: [
            {
              recordSummary: 'FeedItemId → tracked change (1 record)',
              messages: [
                'Not written: FeedItemId may not be left empty, and the tracked change it names ' +
                  'is one the platform writes itself, which no copy sends.',
              ],
            },
          ],
        };

        it('leaves out a comment on a tracked change in a run that reads whole tables, and says so', async () => {
          // Read whole, the comments come with the rest, the one on the tracked
          // change among them: it names a feed item the run never writes, and
          // was held back as a failure for want of its parent.
          const { orgDeps, inserted } = describedOrgs();

          const summary = await new ForgeExecutor(orgDeps).execute(
            describedGraph(),
            'src',
            'tgt',
            onProgress,
          );

          expect(inserted['FeedComment']).toEqual([
            { CommentBody: 'On the post', FeedItemId: 'FeedItem:1' },
          ]);
          expect(summary.failedCount).toBe(0);
          expect(summary.errors).toEqual([leftOut, commentLeftOut]);
          expect(progressEvents.filter((e) => e.objectName === 'FeedComment').pop()).toMatchObject({
            status: 'done',
            message:
              'Completed FeedComment: 1 succeeded, 0 failed, 1 left out: FeedItemId names a ' +
              'tracked change, which the platform writes itself',
          });
        });

        it('says in a dry run of whole tables that a comment on a tracked change would be left out', async () => {
          const { orgDeps } = describedOrgs();

          const summary = await new ForgeExecutor(orgDeps).execute(
            describedGraph(),
            'src',
            'tgt',
            onProgress,
            { dryRun: true },
          );

          expect(
            progressEvents.find((e) => e.objectName === 'FeedComment' && e.status === 'done')
              ?.message,
          ).toBe(
            '[dry-run] FeedComment: 1 record(s) would be inserted, 1 left out: FeedItemId names ' +
              'a tracked change, which the platform writes itself',
          );
          expect(summary.errors).toEqual([leftOut, commentLeftOut]);
        });

        it('does not read a comment on a tracked change through the record while a post of it is in scope', async () => {
          // Read under the record, the comments are held to the feed items in
          // scope, which the tracked change never enters.
          const { orgDeps } = describedOrgs();
          const read = recordReads(orgDeps);

          await new ForgeExecutor(orgDeps).execute(
            describedGraph(),
            'src',
            'tgt',
            onProgress,
            scoped,
          );

          expect([...(read['FeedComment'] ?? [])]).toEqual(['0D7000000000001AAA']);
        });

        it('leaves out a comment on the one feed item of a record, a tracked change, reached through the record', async () => {
          // Scope reaches a comment through its feed item and through the
          // record. With no feed item in scope, nothing held the read to them:
          // the comment on the opportunity's tracked change was read under the
          // opportunity, and held back as a failure for want of its parent.
          const onTheChange = (row: FakeRow): boolean =>
            row['Type'] === 'TrackedChange' || row['FeedItemId'] === CHANGE;
          const rows = withParents({
            ...tables(),
            FeedItem: tables()['FeedItem'].filter(onTheChange),
            FeedComment: tables()['FeedComment'].filter(onTheChange),
          });
          const { orgDeps, inserted } = describedOrgs(rows);

          const summary = await new ForgeExecutor(orgDeps).execute(
            describedGraph(),
            'src',
            'tgt',
            onProgress,
            scoped,
          );

          expect(inserted['FeedComment'] ?? []).toEqual([]);
          expect(summary.failedCount).toBe(0);
          expect(summary.errors).toEqual([leftOut, commentLeftOut]);
        });

        it('sends no tracked change it finds as a missing parent, and leaves out the comment on it', async () => {
          // With the feed items left out of the graph, the comments' feed
          // items are parents the run copies on its way. Fetched by id, the
          // tracked change was sent like the post, and refused.
          const { orgDeps, inserted } = describedOrgs();
          const withoutFeedItems = describedGraph();
          withoutFeedItems.nodes = withoutFeedItems.nodes.map((n) =>
            n.objectApiName === 'FeedItem' ? { ...n, included: false } : n,
          );

          const summary = await new ForgeExecutor(orgDeps).execute(
            withoutFeedItems,
            'src',
            'tgt',
            onProgress,
            { expandOrphanParents: true },
          );

          expect(inserted['FeedItem']).toEqual([{ Body: 'Kick-off', Type: 'TextPost' }]);
          expect(inserted['FeedComment']).toEqual([
            { CommentBody: 'On the post', FeedItemId: 'FeedItem:1' },
          ]);
          expect(summary.failedCount).toBe(0);
          expect(summary.errors).toEqual([leftOut, commentLeftOut]);
        });
      });
    });

    describe('an email, its task and their relations', () => {
      const OPPORTUNITY = '006000000000001AAA';
      const QUOTE = '0Q0000000000001AAA';
      const EMAIL = '02s000000000001AAA';
      const EMAIL_TASK = '00T000000000001AAA';
      /** What a task and an email are related to: nearly any object. */
      const what = (name: string, required = false): FieldInfo => ({
        ...lookup(name, 'Opportunity', required),
        referenceTo: ['Opportunity', 'Quote', 'Contact'],
      });
      const fields: Record<string, FieldInfo[]> = {
        Opportunity: [idField, text('Name')],
        Quote: [idField, text('Name'), lookup('OpportunityId', 'Opportunity')],
        Task: [idField, text('Subject'), text('TaskSubtype'), what('WhatId')],
        EmailMessage: [
          idField,
          text('Subject'),
          text('Status'),
          what('RelatedToId'),
          lookup('ActivityId', 'Task'),
        ],
        TaskRelation: [
          idField,
          lookup('TaskId', 'Task', true),
          what('RelationId', true),
          text('IsWhat'),
        ],
        EmailMessageRelation: [
          idField,
          lookup('EmailMessageId', 'EmailMessage', true),
          text('RelationType'),
          text('RelationAddress'),
        ],
      };
      /** The source as a real one held it: an email sent from a quote, with what the platform wrote of it. */
      const tables = (): Record<string, FakeRow[]> => ({
        Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal' }],
        Quote: [{ Id: QUOTE, Name: 'Offer', OpportunityId: OPPORTUNITY }],
        Task: [
          { Id: EMAIL_TASK, Subject: 'Email: The offer', TaskSubtype: 'Email', WhatId: QUOTE },
        ],
        EmailMessage: [
          {
            Id: EMAIL,
            Subject: 'The offer',
            Status: '3',
            RelatedToId: QUOTE,
            ActivityId: EMAIL_TASK,
          },
        ],
        TaskRelation: [
          { Id: '0RT000000000001AAA', TaskId: EMAIL_TASK, RelationId: QUOTE, IsWhat: true },
        ],
        EmailMessageRelation: [
          {
            Id: '0CZ000000000001AAA',
            EmailMessageId: EMAIL,
            RelationType: 'FromAddress',
            RelationAddress: 'sender@example.com',
          },
          {
            Id: '0CZ000000000002AAA',
            EmailMessageId: EMAIL,
            RelationType: 'ToAddress',
            RelationAddress: 'buyer@example.com',
          },
        ],
      });
      /** The graph discovery draws around the opportunity. */
      const graph = (): ForgeGraph =>
        makeGraph(
          [
            makeNode('Opportunity'),
            makeNode('Quote'),
            makeNode('Task'),
            makeNode('EmailMessage'),
            makeNode('TaskRelation'),
            makeNode('EmailMessageRelation'),
          ],
          [
            edge('Opportunity', 'Quote'),
            edge('Quote', 'Task'),
            edge('Quote', 'EmailMessage'),
            edge('Task', 'EmailMessage'),
            { ...edge('Task', 'TaskRelation'), required: true },
            edge('Quote', 'TaskRelation'),
            { ...edge('EmailMessage', 'EmailMessageRelation'), required: true },
          ],
        );
      const scoped = { rootRecordId: OPPORTUNITY, rootObjectApiName: 'Opportunity' };

      /**
       * The fake orgs, whose target answers as the platform does: it refuses
       * an email naming its task unless the email is on a case, and writes the
       * task of an email related to a record itself as it takes the email; it
       * refuses a task's relation to its what, which it writes with the task,
       * and an email's relation, which it writes from the email's addresses.
       *
       * @param platformWritesTasks - Whether the target writes an email's task.
       */
      function orgs(platformWritesTasks = true) {
        const run = fakeOrgs(tables(), fields);
        const target: Record<string, FakeRow[]> = { EmailMessage: [], TaskRelation: [] };
        const order: string[] = [];
        const insert = run.orgDeps.insertRecords;
        run.orgDeps.insertRecords = async (org, object, records) => {
          if (records.length > 0) order.push(object);
          const refusal = (record: Record<string, unknown>): string | undefined => {
            if (object === 'EmailMessage' && record['ActivityId'] && !record['ParentId']) {
              return 'INSUFFICIENT_ACCESS_OR_READONLY: you cannot modify this field';
            }
            if (object === 'TaskRelation' && record['IsWhat'] !== true) {
              return 'FIELD_INTEGRITY_EXCEPTION: RelationId must be a contact or lead when isWhat is false.';
            }
            if (object === 'EmailMessageRelation') {
              return 'INVALID_OPERATION: operation not allowed';
            }
            return undefined;
          };
          const results = await insert(org, object, records);
          return results.map((result, i) => {
            const refused = refusal(records[i]);
            if (refused) return { id: '', success: false, errors: [refused] };
            if (object === 'EmailMessage') {
              target['EmailMessage'].push({
                Id: result.id,
                ActivityId:
                  platformWritesTasks && records[i]['RelatedToId'] ? '00TPLATFORM0001AAA' : null,
              });
            }
            return result;
          });
        };
        const query = run.orgDeps.queryRecords;
        run.orgDeps.queryRecords = async (org, soql, onTruncated) =>
          org === 'tgt' ? selectRows(target, soql) : query(org, soql, onTruncated);
        return { ...run, order };
      }

      it('sends the email without its task, before it, and links the task the platform wrote with it', async () => {
        // Run for real, the one email of an opportunity went with the task it
        // names and the target refused it: "you cannot modify this field".
        const { orgDeps, inserted, order } = orgs();

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          scoped,
        );

        expect(inserted['EmailMessage']).toEqual([
          { Subject: 'The offer', Status: '3', RelatedToId: 'Quote:Offer' },
        ]);
        expect(inserted['Task'] ?? []).toEqual([]);
        expect(order).toEqual(['Opportunity', 'Quote', 'EmailMessage']);
        expect(summary.remapTable[EMAIL_TASK]).toBe('00TPLATFORM0001AAA');
        expect(summary.existingSourceIds).toContain(EMAIL_TASK);
        expect(summary.createdByObject.map((o) => o.objectApiName)).not.toContain('Task');
        expect(summary.failedCount).toBe(0);
        expect(progressEvents.filter((e) => e.objectName === 'Task').pop()).toMatchObject({
          status: 'done',
          message:
            'Completed Task: 0 succeeded, 1 written by the platform with their email, 0 failed',
        });
      });

      it('writes the task itself, after the email, when the platform wrote none with it', async () => {
        // Each email a clone wrote into a sandbox whose quote it could not
        // write went in related to nothing, and the target gave it no task.
        const { orgDeps, inserted, order } = orgs(false);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          scoped,
        );

        expect(inserted['EmailMessage']).toEqual([
          { Subject: 'The offer', Status: '3', RelatedToId: 'Quote:Offer' },
        ]);
        expect(inserted['Task']).toEqual([
          { Subject: 'Email: The offer', TaskSubtype: 'Email', WhatId: 'Quote:Offer' },
        ]);
        expect(order).toEqual(['Opportunity', 'Quote', 'EmailMessage', 'Task']);
        expect(summary.existingSourceIds).not.toContain(EMAIL_TASK);
        expect(summary.failedCount).toBe(0);
      });

      it("leaves the task's relation to its what and the email's relations to the platform, and says why", async () => {
        const { orgDeps, inserted } = orgs();

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          scoped,
        );

        expect(inserted['TaskRelation'] ?? []).toEqual([]);
        expect(inserted['EmailMessageRelation'] ?? []).toEqual([]);
        expect(summary.failedCount).toBe(0);
        expect(summary.errors).toEqual([
          {
            objectApiName: 'TaskRelation',
            stage: 'scope',
            failedCount: 0,
            attemptedCount: 0,
            samples: [
              {
                recordSummary: 'IsWhat=true (1 record)',
                messages: [
                  "Not written: the platform writes each what relation itself, from the task's WhatId.",
                ],
              },
            ],
          },
          {
            objectApiName: 'EmailMessageRelation',
            stage: 'scope',
            failedCount: 0,
            attemptedCount: 0,
            samples: [
              {
                recordSummary: 'every email relation (2 records)',
                messages: [
                  "Not written: the platform writes each email relation itself, from the email's addresses.",
                ],
              },
            ],
          },
        ]);
        expect(
          progressEvents.filter((e) => e.objectName === 'EmailMessageRelation').pop()?.message,
        ).toBe(
          "Completed EmailMessageRelation: 0 succeeded, 0 failed, 2 email relations left out: the platform writes them itself, from the email's addresses",
        );
      });

      it('keeps the task first and its id on an email on a case, which may name it', async () => {
        const CASE = '500000000000001AAA';
        const caseFields: Record<string, FieldInfo[]> = {
          Case: [idField, text('Subject')],
          Task: [idField, text('Subject'), { ...what('WhatId'), referenceTo: ['Case'] }],
          EmailMessage: [
            idField,
            text('Subject'),
            lookup('ParentId', 'Case'),
            lookup('ActivityId', 'Task'),
          ],
        };
        const run = fakeOrgs(
          {
            Case: [{ Id: CASE, Subject: 'Broken' }],
            Task: [{ Id: EMAIL_TASK, Subject: 'Unread email', WhatId: CASE }],
            EmailMessage: [
              { Id: EMAIL, Subject: 'It is broken', ParentId: CASE, ActivityId: EMAIL_TASK },
            ],
          },
          caseFields,
        );
        const caseGraph = makeGraph(
          [makeNode('Case'), makeNode('Task'), makeNode('EmailMessage')],
          [edge('Case', 'Task'), edge('Case', 'EmailMessage'), edge('Task', 'EmailMessage')],
        );

        const summary = await new ForgeExecutor(run.orgDeps).execute(
          caseGraph,
          'src',
          'tgt',
          onProgress,
          { rootRecordId: CASE, rootObjectApiName: 'Case' },
        );

        expect(Object.keys(run.inserted)).toEqual(['Case', 'Task', 'EmailMessage']);
        expect(run.inserted['EmailMessage']).toEqual([
          { Subject: 'It is broken', ParentId: 'Case:1', ActivityId: 'Task:2' },
        ]);
        expect(summary.errors).toEqual([]);
      });
    });

    describe('what the run read of each object', () => {
      /**
       * The graph discovery builds around an account: the count of each node
       * is the whole table's, the one account among thousands and the contacts
       * of every account. Cases are left out, and nothing read points at a lead.
       */
      const graph = (): ForgeGraph =>
        makeGraph(
          [
            makeNode('Account', { recordCount: 16_000 }),
            makeNode('Contact', { recordCount: 48_000 }),
            makeNode('Case', { recordCount: 9_000, included: false }),
            makeNode('Lead', { recordCount: 12_000 }),
          ],
          [edge('Account', 'Contact')],
        );
      const tables = (): Record<string, FakeRow[]> => ({
        Account: [
          { Id: ACCOUNT, Name: 'Root' },
          { Id: ELSEWHERE_ACCOUNT, Name: 'Elsewhere' },
        ],
        Contact: [
          { Id: KEY_CONTACT, LastName: 'Key', AccountId: ACCOUNT },
          { Id: OTHER_CONTACT, LastName: 'Other', AccountId: ACCOUNT },
          { Id: ELSEWHERE_CONTACT, LastName: 'Elsewhere', AccountId: ELSEWHERE_ACCOUNT },
        ],
        Case: [{ Id: '500000000000001AAA', Subject: 'Left out', AccountId: ACCOUNT }],
        Lead: [{ Id: '00Q000000000001AAA', LastName: 'Unrelated' }],
      });
      const fields: Record<string, FieldInfo[]> = {
        Account: [idField, text('Name')],
        Contact: [idField, text('LastName'), lookup('AccountId', 'Account')],
        Case: [idField, text('Subject'), lookup('AccountId', 'Account')],
        Lead: [idField, text('LastName')],
      };
      const rooted = { rootRecordId: ACCOUNT, rootObjectApiName: 'Account' };
      const readOf = (summary: { readByObject: Array<{ objectApiName: string; read: number }> }) =>
        Object.fromEntries(summary.readByObject.map((r) => [r.objectApiName, r.read]));

      it('counts the rows a record-scoped clone read of each object, not the rows discovery counted in its table', async () => {
        const { orgDeps, inserted } = fakeOrgs(tables(), fields);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          rooted,
        );

        expect(summary.readByObject).toEqual([
          { objectApiName: 'Account', read: 1 },
          { objectApiName: 'Contact', read: 2 },
        ]);
        expect(inserted['Contact'].map((r) => r['LastName'])).toEqual(['Key', 'Other']);
      });

      it('counts what a dry run would insert of each object, as a real run reads it', async () => {
        const { orgDeps, inserted } = fakeOrgs(tables(), fields);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          { ...rooted, dryRun: true },
        );

        expect(summary.readByObject).toEqual([
          { objectApiName: 'Account', read: 1 },
          { objectApiName: 'Contact', read: 2 },
        ]);
        expect(summary.wouldInsertCount).toBe(3);
        expect(inserted).toEqual({});
      });

      it('counts every row a run that reads whole tables read of each object', async () => {
        const { orgDeps } = fakeOrgs(tables(), fields);
        // Read whole, a table comes back with no WHERE to select its rows.
        const everyRow = tables();
        orgDeps.queryRecords = async (_org, soql) =>
          (everyRow[/^SELECT .+ FROM (\w+)$/.exec(soql)?.[1] ?? ''] ?? []).map((row) => ({
            ...row,
          }));

        const summary = await new ForgeExecutor(orgDeps).execute(graph(), 'src', 'tgt', onProgress);

        expect(readOf(summary)).toEqual({ Account: 2, Contact: 3, Lead: 1 });
      });

      it('counts the rows it read of an object the target then refused', async () => {
        const { orgDeps } = fakeOrgs(tables(), fields);
        const insert = orgDeps.insertRecords;
        orgDeps.insertRecords = async (org, object, rows) =>
          object === 'Contact'
            ? rows.map(() => ({ id: '', success: false, errors: ['INVALID_FIELD: refused'] }))
            : insert(org, object, rows);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          rooted,
        );

        expect(readOf(summary)).toEqual({ Account: 1, Contact: 2 });
        expect(summary.failedCount).toBe(2);
      });

      it('lists no object whose read failed: the run never learned how many rows the clone held of it', async () => {
        const { orgDeps } = fakeOrgs(tables(), fields);
        const query = orgDeps.queryRecords;
        orgDeps.queryRecords = async (org, soql, onTruncated) => {
          if (/\bFROM Contact\b/.test(soql)) {
            throw new Error('QUERY_TIMEOUT: the query ran for too long');
          }
          return query(org, soql, onTruncated);
        };

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          rooted,
        );

        expect(summary.readByObject).toEqual([{ objectApiName: 'Account', read: 1 }]);
      });

      /** A source read whole: each statement answers every row of its table, up to its LIMIT. */
      const readWhole = (orgDeps: ForgeExecutorDeps): void => {
        const everyRow = tables();
        orgDeps.queryRecords = async (_org, soql) => {
          const [, object = '', limit] = /^SELECT .+ FROM (\w+)(?: LIMIT (\d+))?$/.exec(soql) ?? [];
          return (everyRow[object] ?? [])
            .slice(0, limit === undefined ? undefined : Number(limit))
            .map((row) => ({ ...row }));
        };
      };

      /** Source reads that fail for `object`, and answer as they did for the others. */
      const failingReadsOf = (object: string, orgDeps: ForgeExecutorDeps): void => {
        const query = orgDeps.queryRecords;
        orgDeps.queryRecords = async (org, soql, onTruncated) => {
          if (new RegExp(`\\bFROM ${object}\\b`).test(soql)) {
            throw new Error('QUERY_TIMEOUT: the query ran for too long');
          }
          return query(org, soql, onTruncated);
        };
      };

      it('counts no record of an object a record-scoped clone could not read, and names the object', async () => {
        // Counted from the graph, the failed read of the account's contacts
        // was every contact of the org: 48 000 records the clone never meant
        // to read, on its results, the command's summary and the audit trail.
        const { orgDeps } = fakeOrgs(tables(), fields);
        failingReadsOf('Contact', orgDeps);

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          rooted,
        );

        expect(summary.failedCount).toBe(0);
        expect(summary.failedReads).toEqual(['Contact']);
        expect(summary.errors.filter((e) => e.objectApiName === 'Contact')).toEqual([
          {
            objectApiName: 'Contact',
            stage: 'query',
            failedCount: 0,
            attemptedCount: 0,
            samples: [
              {
                recordSummary: '(stage failed before insert)',
                messages: ['QUERY_TIMEOUT: the query ran for too long'],
              },
            ],
          },
        ]);
        // The account was written: the run did part of its job.
        expect(finishedRunStatus(summary)).toBe('partial');
      });

      it('ends a record-scoped clone whose every read failed as a failure, with no record counted', async () => {
        const { orgDeps } = fakeOrgs(tables(), fields);
        orgDeps.queryRecords = async () => {
          throw new Error('INVALID_SESSION_ID: Session expired or invalid');
        };

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          rooted,
        );

        expect(summary.failedCount).toBe(0);
        expect(summary.failedReads).toEqual(['Account', 'Contact']);
        expect(finishedRunStatus(summary)).toBe('failure');
      });

      it('counts the table a run of whole tables meant to read of an object it could not read', async () => {
        // Read whole, the table discovery counted is what the read was to bring.
        const { orgDeps } = fakeOrgs(tables(), fields);
        readWhole(orgDeps);
        failingReadsOf('Contact', orgDeps);

        const summary = await new ForgeExecutor(orgDeps).execute(graph(), 'src', 'tgt', onProgress);

        expect(summary.failedCount).toBe(48_000);
        expect(summary.failedReads).toEqual(['Contact']);
        expect(summary.errors.find((e) => e.objectApiName === 'Contact')).toMatchObject({
          stage: 'query',
          failedCount: 48_000,
          attemptedCount: 48_000,
        });
      });

      it('counts no more of the table than the cap on each object, which its read carries', async () => {
        const { orgDeps } = fakeOrgs(tables(), fields);
        readWhole(orgDeps);
        failingReadsOf('Contact', orgDeps);
        const capped = { maxRecordsPerObject: 100 };

        const summary = await new ForgeExecutor(orgDeps).execute(
          graph(),
          'src',
          'tgt',
          onProgress,
          capped,
        );

        expect(summary.failedCount).toBe(100);
        expect(summary.errors.find((e) => e.objectApiName === 'Contact')).toMatchObject({
          failedCount: 100,
          attemptedCount: 100,
        });
      });

      it('ends a run of whole tables whose read failed as a failure, when the graph counted no row', async () => {
        // A starter template's graph counts none: the failed read added no
        // record, and the run that read nothing was called a success.
        const { orgDeps } = fakeOrgs(tables(), fields);
        readWhole(orgDeps);
        failingReadsOf('Account', orgDeps);

        const summary = await new ForgeExecutor(orgDeps).execute(
          makeGraph([makeNode('Account', { recordCount: 0 })]),
          'src',
          'tgt',
          onProgress,
        );

        expect(summary.failedCount).toBe(0);
        expect(summary.failedReads).toEqual(['Account']);
        expect(finishedRunStatus(summary)).toBe('failure');
      });
    });
  });

  describe('2-pass cycle FK update', () => {
    const ROOT_ID = '500XX00000000001AAA';

    it('issues a pass-2 UPDATE for FKs nullified during pass-1 insert', async () => {
      const updateRecords = vi
        .fn<NonNullable<ForgeExecutorDeps['updateRecords']>>()
        .mockResolvedValue([{ id: '001NEW1', success: true, errors: [] }]);
      const depsCycle: ForgeExecutorDeps = { ...deps, updateRecords };
      const cycleExecutor = new ForgeExecutor(depsCycle);

      // 2-cycle: Account.PrimaryContactId references Contact, Contact.AccountId
      // references Account. Process root (Case) → seed Account in cache via FK
      // value extraction → process Account: AccountId NOT in remapper yet for
      // PrimaryContactId, so it gets nullified. After Contact is cloned, pass 2
      // patches PrimaryContactId on Account.
      const graph = makeGraph(
        [makeNode('Account'), makeNode('Contact')],
        [
          {
            sourceObject: 'Contact',
            targetObject: 'Account',
            relationshipName: 'PrimaryContact',
            type: 'lookup',
          },
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
      );

      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Account') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            {
              name: 'PrimaryContactId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Contact'],
            },
          ];
        }
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          {
            name: 'AccountId',
            queryable: true,
            createable: true,
            isReference: true,
            referenceTo: ['Account'],
          },
        ];
      });
      vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) => {
        if (soql.includes('FROM Account')) return [{ Id: '001OLD1', PrimaryContactId: '003OLD1' }];
        if (soql.includes('FROM Contact')) return [{ Id: '003OLD1', AccountId: '001OLD1' }];
        return [];
      });
      vi.mocked(deps.insertRecords).mockImplementation(async (_o, name) => {
        if (name === 'Account') return [{ id: '001NEW1', success: true, errors: [] }];
        if (name === 'Contact') return [{ id: '003NEW1', success: true, errors: [] }];
        return [];
      });

      await cycleExecutor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Account',
      });

      expect(updateRecords).toHaveBeenCalledTimes(1);
      const [, updateObject, updatePayload] = updateRecords.mock.calls[0];
      expect(updateObject).toBe('Account');
      expect(updatePayload[0]).toEqual({ Id: '001NEW1', PrimaryContactId: '003NEW1' });
    });

    it('does not call updateRecords when no FKs need patching', async () => {
      const updateRecords = vi
        .fn<NonNullable<ForgeExecutorDeps['updateRecords']>>()
        .mockResolvedValue([]);
      const depsCycle: ForgeExecutorDeps = { ...deps, updateRecords };
      const cycleExecutor = new ForgeExecutor(depsCycle);

      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID }]);

      await cycleExecutor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      expect(updateRecords).not.toHaveBeenCalled();
    });

    it('coalesces multiple nullified FKs on the same record into a single UPDATE call', async () => {
      const updateRecords = vi
        .fn<NonNullable<ForgeExecutorDeps['updateRecords']>>()
        .mockResolvedValue([{ id: '001NEW1', success: true, errors: [] }]);
      const cycleExecutor = new ForgeExecutor({ ...deps, updateRecords });

      // Account has two FKs both pointing at Contact: PrimaryContactId AND
      // Backup_Contact__c. Both get nullified at insert (Contact not yet
      // cloned), then both must be patched in pass 2 — but in a single
      // UPDATE call to the same Account record.
      const graph = makeGraph(
        [makeNode('Account'), makeNode('Contact')],
        [
          {
            sourceObject: 'Contact',
            targetObject: 'Account',
            relationshipName: 'PrimaryContact',
            type: 'lookup',
          },
          {
            sourceObject: 'Account',
            targetObject: 'Contact',
            relationshipName: 'Contacts',
            type: 'lookup',
          },
        ],
      );

      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Account') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            {
              name: 'PrimaryContactId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Contact'],
            },
            {
              name: 'Backup_Contact__c',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Contact'],
            },
          ];
        }
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          {
            name: 'AccountId',
            queryable: true,
            createable: true,
            isReference: true,
            referenceTo: ['Account'],
          },
        ];
      });
      vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) => {
        if (soql.includes('FROM Account')) {
          return [{ Id: '001OLD1', PrimaryContactId: '003OLD1', Backup_Contact__c: '003OLD1' }];
        }
        if (soql.includes('FROM Contact')) return [{ Id: '003OLD1', AccountId: '001OLD1' }];
        return [];
      });
      vi.mocked(deps.insertRecords).mockImplementation(async (_o, name) => {
        if (name === 'Account') return [{ id: '001NEW1', success: true, errors: [] }];
        if (name === 'Contact') return [{ id: '003NEW1', success: true, errors: [] }];
        return [];
      });

      await cycleExecutor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: '500XX00000000001AAA',
        rootObjectApiName: 'Account',
      });

      expect(updateRecords).toHaveBeenCalledTimes(1);
      const [, , payload] = updateRecords.mock.calls[0];
      expect(payload).toHaveLength(1);
      const merged = payload[0];
      expect(merged.Id).toBe('001NEW1');
      expect(merged.PrimaryContactId).toBe('003NEW1');
      expect(merged.Backup_Contact__c).toBe('003NEW1');
    });

    it('reports unresolved cycle FKs in errors when target parent was never cloned', async () => {
      const updateRecords = vi
        .fn<NonNullable<ForgeExecutorDeps['updateRecords']>>()
        .mockResolvedValue([]);
      const depsCycle: ForgeExecutorDeps = { ...deps, updateRecords };
      const cycleExecutor = new ForgeExecutor(depsCycle);

      const graph = makeGraph([makeNode('Account')]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'PrimaryContactId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['Contact'],
        },
      ]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: '001OLD1', PrimaryContactId: '003ORPHAN' },
      ]);

      const summary = await cycleExecutor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Account',
      });

      // Pass 2 ran but the orphan FK was never resolved — should appear in errors
      const pass2Error = summary.errors.find((e) => e.objectApiName === '__pass2__');
      expect(pass2Error).toBeDefined();
      expect(pass2Error?.samples[0].messages[0]).toContain('could not be resolved');
    });
  });

  describe('upsert mode (auto via externalId)', () => {
    const ROOT_ID = '500XX00000000001AAA';

    it('uses upsertRecords when upsertMode=auto and an externalId field exists', async () => {
      const upsertRecords = vi
        .fn<NonNullable<ForgeExecutorDeps['upsertRecords']>>()
        .mockResolvedValue([{ id: '500NEW1', success: true, errors: [] }]);
      const cycleExecutor = new ForgeExecutor({ ...deps, upsertRecords });

      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, ExternalKey__c: 'KEY-001', Subject: 'Test' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Subject', queryable: true, createable: true, isReference: false },
        {
          name: 'ExternalKey__c',
          queryable: true,
          createable: true,
          isReference: false,
          externalId: true,
        },
      ]);

      await cycleExecutor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        upsertMode: 'auto',
      });

      expect(upsertRecords).toHaveBeenCalledTimes(1);
      const [, , externalIdField, payload] = upsertRecords.mock.calls[0];
      expect(externalIdField).toBe('ExternalKey__c');
      expect(payload[0].ExternalKey__c).toBe('KEY-001');
      expect(deps.insertRecords).not.toHaveBeenCalled();
    });

    it('counts a record the upsert matched by its external id as updated, not created', async () => {
      const upsertRecords = vi
        .fn<NonNullable<ForgeExecutorDeps['upsertRecords']>>()
        .mockResolvedValue([{ id: '500HELD', success: true, created: false, errors: [] }]);
      const upsertExecutor = new ForgeExecutor({ ...deps, upsertRecords });

      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, ExternalKey__c: 'KEY-001', Subject: 'Test' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Subject', queryable: true, createable: true, isReference: false },
        {
          name: 'ExternalKey__c',
          queryable: true,
          createable: true,
          isReference: false,
          externalId: true,
        },
      ]);

      const summary = await upsertExecutor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        upsertMode: 'auto',
      });

      expect(summary.successCount).toBe(0);
      expect(summary.updatedCount).toBe(1);
      expect(summary.remapTable[ROOT_ID]).toBe('500HELD');
      expect(summary.remapByObject).toEqual([
        { objectApiName: 'Case', created: 0, linked: 0, updated: 1 },
      ]);
      // What removing the run's records reads: the record it wrote over is not there.
      expect(summary.createdByObject).toEqual([]);
      const done = progressEvents.find((e) => e.objectName === 'Case' && e.status === 'done');
      expect(done?.message).toBe(
        'Completed Case: 0 succeeded, 1 updated through their external id, 0 failed',
      );
    });

    it('tells the table rows the run created from the ones an upsert wrote over', async () => {
      const MATCHED_ID = '500XX00000000002AAA';
      const upsertRecords = vi
        .fn<NonNullable<ForgeExecutorDeps['upsertRecords']>>()
        .mockResolvedValue([
          { id: '500NEW', success: true, created: true, errors: [] },
          { id: '500HELD', success: true, created: false, errors: [] },
        ]);
      const upsertExecutor = new ForgeExecutor({ ...deps, upsertRecords });
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, ExternalKey__c: 'KEY-001', Subject: 'Created' },
        { Id: MATCHED_ID, ExternalKey__c: 'KEY-002', Subject: 'Matched' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Subject', queryable: true, createable: true, isReference: false },
        {
          name: 'ExternalKey__c',
          queryable: true,
          createable: true,
          isReference: false,
          externalId: true,
        },
      ]);

      const summary = await upsertExecutor.execute(
        makeGraph([makeNode('Case')]),
        'src',
        'tgt',
        onProgress,
        { rootRecordId: ROOT_ID, rootObjectApiName: 'Case', upsertMode: 'auto' },
      );

      expect(summary.updatedSourceIds).toEqual([MATCHED_ID]);
      // The table less the rows the target held and the ones written over:
      // exactly what the run created.
      const notCreated = new Set([...summary.existingSourceIds, ...summary.updatedSourceIds]);
      expect(Object.keys(summary.remapTable).filter((id) => !notCreated.has(id))).toEqual(
        summary.createdByObject.flatMap((object) => object.sourceIds),
      );
      expect(summary.createdByObject).toEqual([{ objectApiName: 'Case', sourceIds: [ROOT_ID] }]);
    });

    it('falls back to insert when no externalId field is present', async () => {
      const upsertRecords = vi
        .fn<NonNullable<ForgeExecutorDeps['upsertRecords']>>()
        .mockResolvedValue([]);
      const cycleExecutor = new ForgeExecutor({ ...deps, upsertRecords });

      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID, Subject: 'Test' }]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Subject', queryable: true, createable: true, isReference: false },
      ]);

      await cycleExecutor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        upsertMode: 'auto',
      });

      expect(upsertRecords).not.toHaveBeenCalled();
      expect(deps.insertRecords).toHaveBeenCalledTimes(1);
    });

    it('always inserts when upsertMode is undefined (back-compat)', async () => {
      const upsertRecords = vi
        .fn<NonNullable<ForgeExecutorDeps['upsertRecords']>>()
        .mockResolvedValue([]);
      const cycleExecutor = new ForgeExecutor({ ...deps, upsertRecords });

      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID, ExternalKey__c: 'KEY-001' }]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'ExternalKey__c',
          queryable: true,
          createable: true,
          isReference: false,
          externalId: true,
        },
      ]);

      await cycleExecutor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        // no upsertMode — defaults to insert
      });

      expect(upsertRecords).not.toHaveBeenCalled();
      expect(deps.insertRecords).toHaveBeenCalledTimes(1);
    });
  });

  describe('single-hop orphan parent expansion', () => {
    const ROOT_ID = '500XX00000000001AAA';

    it('fetches+inserts the missing parent when expandOrphanParents=true and patches the child FK', async () => {
      // Asset has Account as a *required* FK pointing at an Account that
      // wasn't in the discovery graph. With expandOrphanParents=true the
      // executor pulls that Account from source, inserts it on target,
      // and the Asset insert then includes the new mapped AccountId.
      const graph = makeGraph([makeNode('Asset')]);
      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Asset') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            { name: 'Name', queryable: true, createable: true, isReference: false },
            {
              name: 'AccountId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Account'],
              nillable: false,
            },
          ];
        }
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'Name', queryable: true, createable: true, isReference: false },
        ];
      });
      vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) => {
        if (soql.includes('FROM Asset'))
          return [{ Id: '02iOLD1', Name: 'BMW X6', AccountId: '001AP00ORPHAN12' }];
        if (soql.includes('FROM Account'))
          return [{ Id: '001AP00ORPHAN12', Name: 'GAN ASSURANCES' }];
        return [];
      });
      vi.mocked(deps.insertRecords).mockImplementation(async (_o, name) => {
        if (name === 'Asset') return [{ id: '02iNEW1', success: true, errors: [] }];
        if (name === 'Account') return [{ id: '001NEW_EXPANDED', success: true, errors: [] }];
        return [];
      });

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Asset',
        expandOrphanParents: true,
      });

      const accountInsert = vi
        .mocked(deps.insertRecords)
        .mock.calls.find((c) => c[1] === 'Account');
      expect(accountInsert).toBeDefined();
      const assetInsert = vi.mocked(deps.insertRecords).mock.calls.find((c) => c[1] === 'Asset');
      expect(assetInsert).toBeDefined();
      expect(assetInsert![2][0].AccountId).toBe('001NEW_EXPANDED');
      expect(
        summary.errors.find((e) => e.objectApiName === '__expandOrphanParents__'),
      ).toBeUndefined();
    });

    it('anonymizes an expanded parent with the fields selected on its object', async () => {
      // Account is in the graph, left out of the copy: its selection still
      // says what of an Account is personal, and a parent fetched from
      // outside the scope carries it like any other row.
      const graph = makeGraph([makeNode('Asset'), makeNode('Account', { included: false })]);
      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Asset') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            {
              name: 'AccountId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Account'],
              nillable: false,
            },
          ];
        }
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'Name', queryable: true, createable: true, isReference: false, type: 'string' },
          { name: 'Phone', queryable: true, createable: true, isReference: false, type: 'phone' },
        ];
      });
      vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) => {
        if (soql.includes('FROM Asset')) return [{ Id: '02iOLD1', AccountId: '001AP00ORPHAN12' }];
        if (soql.includes('FROM Account'))
          return [{ Id: '001AP00ORPHAN12', Name: 'Parent', Phone: '0102030405' }];
        return [];
      });
      vi.mocked(deps.insertRecords).mockImplementation(async (_o, name) => [
        { id: name === 'Account' ? '001NEW_EXPANDED' : '02iNEW1', success: true, errors: [] },
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Asset',
        expandOrphanParents: true,
        anonymization: { fields: { Account: ['Phone'] }, methods: { phone: 'redact' } },
      });

      const accountInsert = vi
        .mocked(deps.insertRecords)
        .mock.calls.find((c) => c[1] === 'Account');
      expect(accountInsert?.[2]).toEqual([{ Name: 'Parent', Phone: '[REDACTED]' }]);
    });

    describe('an expanded parent of an object the graph has no node for', () => {
      /** Asset with a required Account the graph does not reach. */
      function assetWithOrphanAccount(): void {
        vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
          if (name === 'Asset') {
            return [
              { name: 'Id', queryable: true, createable: false, isReference: false },
              {
                name: 'AccountId',
                queryable: true,
                createable: true,
                isReference: true,
                referenceTo: ['Account'],
                nillable: false,
              },
            ];
          }
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            { name: 'Name', queryable: true, createable: true, isReference: false, type: 'string' },
            { name: 'Phone', queryable: true, createable: true, isReference: false, type: 'phone' },
          ];
        });
        vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) => {
          if (soql.includes('FROM Asset'))
            return [
              { Id: '02iOLD1', AccountId: '001AP00ORPHAN12' },
              { Id: '02iOLD2', AccountId: '001AP00ORPHAN13' },
            ];
          if (soql.includes("'001AP00ORPHAN12'"))
            return [{ Id: '001AP00ORPHAN12', Name: 'Parent', Phone: '0102030405' }];
          if (soql.includes("'001AP00ORPHAN13'"))
            return [{ Id: '001AP00ORPHAN13', Name: 'Other', Phone: '0607080910' }];
          return [];
        });
        vi.mocked(deps.insertRecords).mockImplementation(async (_o, name, records) =>
          records.map((_, i) => ({
            id: name === 'Account' ? `001NEW_EXPANDED${i}` : `02iNEW${i}`,
            success: true,
            errors: [],
          })),
        );
      }

      /** What the run's detector names: the phone fields. */
      const phones = vi.fn((fields: Array<{ name: string; type: string }>) =>
        fields.filter((f) => f.type === 'phone').map((f) => f.name),
      );

      beforeEach(() => {
        phones.mockClear();
      });

      it('anonymizes the fields the run’s detector names on it', async () => {
        assetWithOrphanAccount();

        await executor.execute(makeGraph([makeNode('Asset')]), 'src', 'tgt', onProgress, {
          rootRecordId: ROOT_ID,
          rootObjectApiName: 'Asset',
          expandOrphanParents: true,
          // Asset's node was described and selects nothing; Account has none.
          anonymization: {
            fields: { Asset: [] },
            methods: { phone: 'redact' },
            personalFieldsOf: phones,
          },
        });

        const accountInserts = vi
          .mocked(deps.insertRecords)
          .mock.calls.filter((c) => c[1] === 'Account')
          .flatMap((c) => c[2]);
        expect(accountInserts).toEqual([
          { Name: 'Parent', Phone: '[REDACTED]' },
          { Name: 'Other', Phone: '[REDACTED]' },
        ]);
        // Named once for the object, not once per parent fetched.
        expect(phones).toHaveBeenCalledTimes(1);
      });

      it('writes it as the source holds it when the run does not anonymize', async () => {
        assetWithOrphanAccount();

        await executor.execute(makeGraph([makeNode('Asset')]), 'src', 'tgt', onProgress, {
          rootRecordId: ROOT_ID,
          rootObjectApiName: 'Asset',
          expandOrphanParents: true,
        });

        const accountInsert = vi
          .mocked(deps.insertRecords)
          .mock.calls.find((c) => c[1] === 'Account');
        expect(accountInsert?.[2]).toEqual([{ Name: 'Parent', Phone: '0102030405' }]);
      });

      it('keeps what a node says of its object over the detector, down to an empty selection', async () => {
        assetWithOrphanAccount();

        await executor.execute(
          makeGraph([makeNode('Asset'), makeNode('Account', { included: false })]),
          'src',
          'tgt',
          onProgress,
          {
            rootRecordId: ROOT_ID,
            rootObjectApiName: 'Asset',
            expandOrphanParents: true,
            anonymization: {
              fields: { Asset: [], Account: [] },
              methods: { phone: 'redact' },
              personalFieldsOf: phones,
            },
          },
        );

        const accountInsert = vi
          .mocked(deps.insertRecords)
          .mock.calls.find((c) => c[1] === 'Account');
        expect(accountInsert?.[2]).toEqual([{ Name: 'Parent', Phone: '0102030405' }]);
        expect(phones).not.toHaveBeenCalled();
      });
    });

    it('respects maxOrphanParentExpansions cap', async () => {
      const graph = makeGraph([makeNode('Asset', { recordCount: 3 })]);
      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Asset') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            {
              name: 'AccountId',
              queryable: true,
              createable: true,
              isReference: true,
              referenceTo: ['Account'],
              nillable: false,
            },
          ];
        }
        return [{ name: 'Id', queryable: true, createable: false, isReference: false }];
      });
      vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) => {
        if (soql.includes('FROM Asset'))
          // Real 15-character Ids: expansion refuses anything else before
          // fetching, which is how this test used to pass with zero inserts.
          return [
            { Id: '02iA', AccountId: '001AP00ORPHAN01' },
            { Id: '02iB', AccountId: '001AP00ORPHAN02' },
            { Id: '02iC', AccountId: '001AP00ORPHAN03' },
          ];
        if (soql.includes('FROM Account')) {
          // each parent fetch returns one row
          return [{ Id: 'matched', Name: 'X' }];
        }
        return [];
      });
      vi.mocked(deps.insertRecords).mockImplementation(async (_o, name) => {
        if (name === 'Account') return [{ id: 'newAcc', success: true, errors: [] }];
        return [];
      });

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Asset',
        expandOrphanParents: true,
        maxOrphanParentExpansions: 2, // only 2 of the 3 orphans get expanded
      });

      const accountInserts = vi
        .mocked(deps.insertRecords)
        .mock.calls.filter((c) => c[1] === 'Account');
      expect(accountInserts).toHaveLength(2);
    });

    it('does nothing when expandOrphanParents is false (back-compat)', async () => {
      const graph = makeGraph([makeNode('Asset')]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'AccountId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['Account'],
          nillable: false,
        },
      ]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: '02iA', AccountId: '001ORPHAN' }]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Asset',
      });

      const accountInsert = vi
        .mocked(deps.insertRecords)
        .mock.calls.find((c) => c[1] === 'Account');
      expect(accountInsert).toBeUndefined();
    });
  });

  describe('orphan FK handling (referenceFallback)', () => {
    const ROOT_ID = '500XX00000000001AAA';

    it('omits reference fields whose value is not in the remapper (default in scoped mode)', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, OwnerId: '005USER1', AccountId: '001UNCLONED' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'OwnerId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['User'],
        },
        {
          name: 'AccountId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['Account'],
        },
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      const insertCall = vi.mocked(deps.insertRecords).mock.calls[0];
      expect(insertCall).toBeDefined();
      const inserted = insertCall![2][0];
      // Orphaned FKs are OMITTED from the payload entirely so Salesforce can
      // auto-fill required fields like OwnerId. Sending an explicit `null`
      // would make the platform reject the insert with INVALID_CROSS_REFERENCE_KEY.
      expect('OwnerId' in inserted).toBe(false);
      expect('AccountId' in inserted).toBe(false);
    });

    it('preserves RecordTypeId even when no remap entry exists', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, RecordTypeId: '012XXXXXXXXXXXX' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'RecordTypeId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['RecordType'],
        },
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      const inserted = vi.mocked(deps.insertRecords).mock.calls[0]![2][0];
      expect(inserted.RecordTypeId).toBe('012XXXXXXXXXXXX');
    });

    it('keeps original FK values when referenceFallback="keep"', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID, OwnerId: '005USER1' }]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'OwnerId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['User'],
        },
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        referenceFallback: 'keep',
      });

      const inserted = vi.mocked(deps.insertRecords).mock.calls[0]![2][0];
      expect(inserted.OwnerId).toBe('005USER1');
    });

    it('legacy non-scoped mode defaults to "keep" — back-compat', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID, OwnerId: '005USER1' }]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'OwnerId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['User'],
        },
      ]);

      // No options → legacy mode
      await executor.execute(graph, 'src', 'tgt', onProgress);

      const inserted = vi.mocked(deps.insertRecords).mock.calls[0]![2][0];
      expect(inserted.OwnerId).toBe('005USER1');
    });
  });

  describe('maxRecordsPerObject (sampling cap)', () => {
    const ROOT_ID = '500XX00000000001AAA';

    it('appends LIMIT N to scoped SOQL when maxRecordsPerObject is set', async () => {
      const graph = makeGraph([makeNode('Case')]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        maxRecordsPerObject: 50,
      });

      const queryCalls = vi.mocked(deps.queryRecords).mock.calls;
      expect(queryCalls[0][1]).toContain('LIMIT 50');
    });

    it('does not append LIMIT when maxRecordsPerObject is undefined or 0', async () => {
      const graph = makeGraph([makeNode('Case')]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });
      const noLimitCalls = vi.mocked(deps.queryRecords).mock.calls;
      expect(noLimitCalls[0][1]).not.toContain('LIMIT');

      vi.mocked(deps.queryRecords).mockClear();

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        maxRecordsPerObject: 0,
      });
      const zeroLimitCalls = vi.mocked(deps.queryRecords).mock.calls;
      expect(zeroLimitCalls[0][1]).not.toContain('LIMIT');
    });
  });

  describe('RecordType mapping', () => {
    const ROOT_ID = '500XX00000000001AAA';
    const SOURCE_RT = '012SOURCE000001';
    const TARGET_RT = '012TARGET000001';

    it('translates RecordTypeId from source to target via mapping', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, RecordTypeId: SOURCE_RT, Name: 'X' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Name', queryable: true, createable: true, isReference: false },
        {
          name: 'RecordTypeId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['RecordType'],
        },
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        recordTypeMappings: [
          { sourceId: SOURCE_RT, targetId: TARGET_RT, developerName: 'CaseStandard' },
        ],
      });

      const inserted = vi.mocked(deps.insertRecords).mock.calls[0]![2][0];
      expect(inserted.RecordTypeId).toBe(TARGET_RT);
    });

    it('leaves RecordTypeId unchanged when no mapping is provided', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID, RecordTypeId: SOURCE_RT }]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'RecordTypeId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['RecordType'],
        },
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      const inserted = vi.mocked(deps.insertRecords).mock.calls[0]![2][0];
      expect(inserted.RecordTypeId).toBe(SOURCE_RT);
    });

    it('leaves unmatched RecordTypeId untouched (developerName not in mapping)', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, RecordTypeId: '012UNKNOWN0000' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'RecordTypeId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['RecordType'],
        },
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        recordTypeMappings: [
          { sourceId: SOURCE_RT, targetId: TARGET_RT, developerName: 'CaseStandard' },
        ],
      });

      const inserted = vi.mocked(deps.insertRecords).mock.calls[0]![2][0];
      expect(inserted.RecordTypeId).toBe('012UNKNOWN0000');
    });

    it('warns once per object about a RecordTypeId the target org has no match for', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, RecordTypeId: '012UNKNOWN0000' },
        { Id: '500XX00000000002AAA', RecordTypeId: '012UNKNOWN0000' },
        { Id: '500XX00000000003AAA', RecordTypeId: SOURCE_RT },
      ]);
      vi.mocked(deps.insertRecords).mockImplementation(async (_o, _n, recs) =>
        recs.map((_, i) => ({ id: `500NEW${i}`, success: true, errors: [] })),
      );
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'RecordTypeId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['RecordType'],
        },
      ]);
      vi.mocked(logger.warn).mockClear();

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        recordTypeMappings: [
          { sourceId: SOURCE_RT, targetId: TARGET_RT, developerName: 'CaseStandard' },
        ],
      });

      const warnings = vi
        .mocked(logger.warn)
        .mock.calls.map((c) => c[0])
        .filter((m) => m.includes('RecordTypeId'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Case');
      expect(warnings[0]).toContain('012UNKNOWN0000');
      const written = vi.mocked(deps.insertRecords).mock.calls[0]![2];
      expect(written.map((r) => r.RecordTypeId)).toEqual([
        '012UNKNOWN0000',
        '012UNKNOWN0000',
        TARGET_RT,
      ]);
    });

    it('warns about untranslated record types even when the target org shares none', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID, RecordTypeId: SOURCE_RT }]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'RecordTypeId',
          queryable: true,
          createable: true,
          isReference: true,
          referenceTo: ['RecordType'],
        },
      ]);
      vi.mocked(logger.warn).mockClear();

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        recordTypeMappings: [],
      });

      expect(vi.mocked(logger.warn).mock.calls.some((c) => c[0].includes(SOURCE_RT))).toBe(true);
    });
  });

  describe('dryRun mode', () => {
    const ROOT_ID = '500XX00000000001AAA';

    it('should query source records but never call insertRecords', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID, Name: 'Test' }]);

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        dryRun: true,
      });

      expect(deps.queryRecords).toHaveBeenCalled();
      expect(deps.insertRecords).not.toHaveBeenCalled();
      expect(summary.remapCount).toBe(0);
    });

    it('counts what a dry run would insert under its own name, and nothing as created', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID, Name: 'Test' }]);

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        dryRun: true,
      });

      expect(summary.successCount).toBe(0);
      expect(summary.wouldInsertCount).toBe(1);
    });

    it('should emit a [dry-run] message in progress events', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([{ Id: ROOT_ID }]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        dryRun: true,
      });

      const dryRunEvent = progressEvents.find((e) => e.message.includes('[dry-run]'));
      expect(dryRunEvent).toBeDefined();
      expect(dryRunEvent?.status).toBe('done');
    });

    it('should still populate scope cache so downstream nodes can scope', async () => {
      const graph = makeGraph(
        [makeNode('Case'), makeNode('CaseHistory')],
        [
          {
            sourceObject: 'Case',
            targetObject: 'CaseHistory',
            relationshipName: 'Histories',
            type: 'lookup',
          },
        ],
      );
      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Case') {
          return [{ name: 'Id', queryable: true, createable: false, isReference: false }];
        }
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          {
            name: 'CaseId',
            queryable: true,
            createable: true,
            isReference: true,
            referenceTo: ['Case'],
          },
        ];
      });
      vi.mocked(deps.queryRecords).mockImplementation(async (_o, soql) => {
        if (soql.includes('FROM Case ')) return [{ Id: ROOT_ID }];
        if (soql.includes('FROM CaseHistory')) return [];
        return [];
      });

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        dryRun: true,
      });

      const historyCall = vi
        .mocked(deps.queryRecords)
        .mock.calls.find((c) => c[1].includes('FROM CaseHistory'));
      expect(historyCall).toBeDefined();
      expect(historyCall![1]).toContain(`CaseId IN ('${ROOT_ID}')`);
    });
  });

  describe('rows the run finds in the target instead of writing them', () => {
    it('counts reference data matched by name as linked, not created', async () => {
      const SOURCE_HOURS = '01m000000000001SRC';
      const TARGET_HOURS = '01m000000000001AAA';
      vi.mocked(deps.queryRecords).mockImplementation(async (orgId) =>
        orgId === 'tgt'
          ? [{ Id: TARGET_HOURS, Name: 'Default' }]
          : [{ Id: SOURCE_HOURS, Name: 'Default' }],
      );

      const summary = await executor.execute(
        makeGraph([makeNode('BusinessHours')]),
        'src',
        'tgt',
        onProgress,
      );

      expect(deps.insertRecords).not.toHaveBeenCalled();
      expect(summary.successCount).toBe(0);
      expect(summary.linkedCount).toBe(1);
      expect(summary.remapTable).toEqual({ [SOURCE_HOURS]: TARGET_HOURS });
      expect(summary.existingSourceIds).toEqual([SOURCE_HOURS]);
      expect(summary.createdByObject).toEqual([]);
    });

    it('finds reference data by name in a dry run too, as linked and not to be inserted', async () => {
      const SOURCE_HOURS = '01m000000000001SRC';
      const TARGET_HOURS = '01m000000000001AAA';
      vi.mocked(deps.queryRecords).mockImplementation(async (orgId) =>
        orgId === 'tgt'
          ? [{ Id: TARGET_HOURS, Name: 'Default' }]
          : [{ Id: SOURCE_HOURS, Name: 'Default' }],
      );

      const summary = await executor.execute(
        makeGraph([makeNode('BusinessHours')]),
        'src',
        'tgt',
        onProgress,
        { dryRun: true },
      );

      expect(deps.insertRecords).not.toHaveBeenCalled();
      expect(summary.wouldInsertCount ?? 0).toBe(0);
      expect(summary.linkedCount).toBe(1);
    });

    it('counts the reference data it read among the rows of the clone, found by name or not', async () => {
      vi.mocked(deps.queryRecords).mockImplementation(async (orgId) =>
        orgId === 'tgt'
          ? [{ Id: '01m000000000001AAA', Name: 'Default' }]
          : [
              { Id: '01m000000000001SRC', Name: 'Default' },
              { Id: '01m000000000002SRC', Name: 'Weekend' },
            ],
      );

      const summary = await executor.execute(
        makeGraph([makeNode('BusinessHours', { recordCount: 40 })]),
        'src',
        'tgt',
        onProgress,
      );

      expect(summary.readByObject).toEqual([{ objectApiName: 'BusinessHours', read: 2 }]);
      expect(summary.linkedCount).toBe(1);
    });

    it('names the standard price book among the records the target already held', async () => {
      const SOURCE_BOOK = '01s000000000001SRC';
      const TARGET_BOOK = '01s000000000001AAA';
      vi.mocked(deps.queryRecords).mockImplementation(async (orgId, soql) => {
        if (soql !== STANDARD_PRICEBOOK_SOQL) return [];
        return [{ Id: orgId === 'tgt' ? TARGET_BOOK : SOURCE_BOOK }];
      });

      const summary = await executor.execute(
        makeGraph([makeNode('PricebookEntry')]),
        'src',
        'tgt',
        onProgress,
      );

      expect(summary.remapTable).toEqual({ [SOURCE_BOOK]: TARGET_BOOK });
      expect(summary.existingSourceIds).toEqual([SOURCE_BOOK]);
      expect(summary.createdByObject).toEqual([]);
    });
  });

  describe('target createable check', () => {
    type CreatableCheck = NonNullable<ForgeExecutorDeps['isObjectCreatable']>;

    it('asks the target about every included object before the first insert', async () => {
      const events: string[] = [];
      let release: (creatable: boolean) => void = () => undefined;
      const answer = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      deps.isObjectCreatable = vi.fn<CreatableCheck>(async (_orgId, objectName) => {
        events.push(`check:${objectName}`);
        return answer;
      });
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objectName, records) => {
        events.push(`insert:${objectName}`);
        return records.map((_r, i) => ({
          id: `001NEW${objectName}${i}`,
          success: true,
          errors: [],
        }));
      });
      executor = new ForgeExecutor(deps);
      const graph = makeGraph([makeNode('Account'), makeNode('Contact'), makeNode('Case')]);

      const run = executor.execute(graph, 'src', 'tgt', onProgress);
      // Every check is in flight while the first answer is still pending;
      // awaited inside the node loop, only one would have been made.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deps.isObjectCreatable).toHaveBeenCalledTimes(3);

      release(true);
      const summary = await run;

      const firstInsert = events.findIndex((e) => e.startsWith('insert:'));
      expect(firstInsert).toBeGreaterThan(-1);
      expect(events.slice(0, firstInsert).sort()).toEqual([
        'check:Account',
        'check:Case',
        'check:Contact',
      ]);
      expect(summary.successCount).toBe(6);
    });

    it('reports a check that failed and skips an object the target refuses', async () => {
      deps.isObjectCreatable = vi.fn<CreatableCheck>(async (_orgId, objectName) => {
        if (objectName === 'Contact') throw new Error('describe blocked');
        return objectName !== 'Case';
      });
      executor = new ForgeExecutor(deps);
      const graph = makeGraph([makeNode('Account'), makeNode('Contact'), makeNode('Case')]);

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.errors).toContainEqual(
        expect.objectContaining({
          objectApiName: 'Contact',
          samples: [
            {
              recordSummary: '(target describe failed)',
              messages: ['isObjectCreatable check failed: describe blocked'],
            },
          ],
        }),
      );
      expect(summary.errors).toContainEqual(
        expect.objectContaining({
          objectApiName: 'Case',
          samples: [
            {
              recordSummary: '(node-level skip)',
              messages: ['Object is not createable on target org'],
            },
          ],
        }),
      );
      // A failed check does not decide for the object: it is still attempted.
      const inserted = vi.mocked(deps.insertRecords).mock.calls.map((c) => c[1]);
      expect(inserted.sort()).toEqual(['Account', 'Contact']);
      expect(summary.skippedCount).toBe(1);
      // One row of the refused object says the run holds some: no more is read.
      expect(deps.queryRecords).toHaveBeenCalledWith('src', 'SELECT Id, Name FROM Case LIMIT 1');
    });

    describe('in a record-scoped run', () => {
      const ACCOUNT = '001000000000001AAA';
      const FIRST_CASE = '500000000000001AAA';
      const SECOND_CASE = '500000000000002AAA';
      const idField: FieldInfo = {
        name: 'Id',
        queryable: true,
        createable: false,
        isReference: false,
      };
      const name: FieldInfo = {
        name: 'Name',
        queryable: true,
        createable: true,
        isReference: false,
      };
      const lookup = (field: string, target: string): FieldInfo => ({
        name: field,
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: [target],
        nillable: true,
      });
      const FIELDS: Record<string, FieldInfo[]> = {
        Account: [idField, name],
        Case: [idField, name, lookup('AccountId', 'Account')],
        CaseComment: [idField, name, lookup('ParentId', 'Case')],
      };
      /** An account, the cases under it and a comment under the first case. */
      const GRAPH = makeGraph(
        [makeNode('Account'), makeNode('Case'), makeNode('CaseComment')],
        [
          {
            sourceObject: 'Account',
            targetObject: 'Case',
            relationshipName: 'Cases',
            type: 'lookup',
          },
          {
            sourceObject: 'Case',
            targetObject: 'CaseComment',
            relationshipName: 'CaseComments',
            type: 'lookup',
          },
        ],
      );

      const NOT_CREATEABLE = {
        objectApiName: 'Case',
        stage: 'scope',
        failedCount: 0,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: '(node-level skip)',
            messages: ['Object is not createable on target org'],
          },
        ],
      };

      /**
       * A clone of the account from a source holding `cases`, and a comment
       * under the first, into a target that refuses cases. `fails` makes the
       * source's read or describe of cases fail; `dryRun` writes nothing.
       */
      async function cloneRefusingCases(
        cases: FakeRow[],
        fails?: 'read' | 'describe',
        dryRun = false,
      ) {
        const tables: Record<string, FakeRow[]> = {
          Account: [{ Id: ACCOUNT, Name: 'Root' }],
          Case: cases,
          CaseComment: [{ Id: '00a000000000001AAA', Name: 'Note', ParentId: FIRST_CASE }],
        };
        deps.describeFields = vi.fn<ForgeExecutorDeps['describeFields']>(
          async (_orgId, objectName) => {
            if (fails === 'describe' && objectName === 'Case') {
              throw new Error('INVALID_TYPE: sObject type Case is not supported.');
            }
            return FIELDS[objectName] ?? [idField];
          },
        );
        deps.queryRecords = vi.fn<ForgeExecutorDeps['queryRecords']>(async (orgId, soql) => {
          if (orgId !== 'src') return [];
          if (fails === 'read' && soql.includes('FROM Case ')) {
            throw new Error('QUERY_TIMEOUT: Your query request was running for too long.');
          }
          return selectRows(tables, soql);
        });
        deps.insertRecords = vi.fn<ForgeExecutorDeps['insertRecords']>(
          async (_orgId, objectName, records) =>
            records.map((_record, i) => ({
              id: `${objectName}:${String(i)}`,
              success: true,
              errors: [],
            })),
        );
        deps.isObjectCreatable = vi.fn<CreatableCheck>(
          async (_orgId, objectName) => objectName !== 'Case',
        );
        const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', onProgress, {
          rootRecordId: ACCOUNT,
          rootObjectApiName: 'Account',
          dryRun,
        });
        const reads = vi
          .mocked(deps.queryRecords)
          .mock.calls.filter(([orgId]) => orgId === 'src')
          .map(([, soql]) => soql);
        const inserted = vi
          .mocked(deps.insertRecords)
          .mock.calls.map(([, objectName]) => objectName);
        return { summary, reads, inserted };
      }

      it('skips without an error an object the target refuses when the clone holds none of its records', async () => {
        const { summary, inserted } = await cloneRefusingCases([]);

        expect(summary.errors).toEqual([]);
        expect(progressEvents).toContainEqual({
          objectName: 'Case',
          status: 'skipped',
          progress: 100,
          message:
            'Skipped Case (target org rejects inserts on this entity; ' +
            'the clone holds none of its records)',
        });
        expect(inserted).toEqual(['Account']);
      });

      it('reports an object the target refuses when the clone holds records of it, from one row and nothing under it', async () => {
        const { summary, reads, inserted } = await cloneRefusingCases([
          { Id: FIRST_CASE, Name: 'First', AccountId: ACCOUNT },
          { Id: SECOND_CASE, Name: 'Second', AccountId: ACCOUNT },
        ]);

        expect(summary.errors).toEqual([NOT_CREATEABLE]);
        expect(reads.filter((soql) => soql.includes('FROM Case '))).toEqual([
          `SELECT Id, Name, AccountId FROM Case WHERE AccountId IN ('${ACCOUNT}') LIMIT 1`,
        ]);
        // Never written, the cases bring nothing under them into the clone:
        // the comment is not read, as when the object was not read at all.
        expect(reads.some((soql) => soql.includes('FROM CaseComment'))).toBe(false);
        expect(inserted).toEqual(['Account']);
      });

      it('says in a dry run what a real run would refuse, and counts none of it as to be inserted', async () => {
        const cases = [
          { Id: FIRST_CASE, Name: 'First', AccountId: ACCOUNT },
          { Id: SECOND_CASE, Name: 'Second', AccountId: ACCOUNT },
        ];
        const real = await cloneRefusingCases(cases);
        progressEvents = [];
        const dry = await cloneRefusingCases(cases, undefined, true);

        expect(dry.summary.errors).toEqual([NOT_CREATEABLE]);
        expect(dry.summary.errors).toEqual(real.summary.errors);
        expect(dry.summary.skippedCount).toBe(real.summary.skippedCount);
        // The account alone, as the real run wrote it alone: listed as well,
        // the cases and the comment under them were three records "to be
        // inserted" that a real run never writes.
        expect(real.summary.successCount).toBe(1);
        expect(dry.summary.wouldInsertCount).toBe(1);
        expect(progressEvents.some((e) => e.message.startsWith('[dry-run] Case'))).toBe(false);
        expect(dry.reads.filter((soql) => soql.includes('FROM Case '))).toEqual([
          `SELECT Id, Name, AccountId FROM Case WHERE AccountId IN ('${ACCOUNT}') LIMIT 1`,
        ]);
        expect(dry.reads.some((soql) => soql.includes('FROM CaseComment'))).toBe(false);
        expect(dry.inserted).toEqual([]);
      });

      it.each(['read', 'describe'] as const)(
        'reports an object the target refuses, failing none of its records, when its %s fails',
        async (fails) => {
          const { summary } = await cloneRefusingCases(
            [{ Id: FIRST_CASE, Name: 'First', AccountId: ACCOUNT }],
            fails,
          );

          // Whether the clone holds a record of it is unknown: it is reported
          // as when it does, and none of its records is counted as failed.
          expect(summary.errors).toEqual([NOT_CREATEABLE]);
          expect(summary.failedCount).toBe(0);
          expect(summary.successCount).toBe(1);
        },
      );
    });

    it('keeps the describes it starts under the connection-pool cap', async () => {
      const names = ['Account', 'Contact', 'Case', 'Lead', 'Opportunity', 'Task', 'Event', 'Asset'];
      const asked: string[] = [];
      let inFlight = 0;
      let peak = 0;
      deps.isObjectCreatable = vi.fn<CreatableCheck>(async (_orgId, objectName) => {
        asked.push(objectName);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight--;
        return true;
      });
      executor = new ForgeExecutor(deps);

      await executor.execute(
        makeGraph(names.map((name) => makeNode(name))),
        'src',
        'tgt',
        onProgress,
      );

      expect([...asked].sort()).toEqual([...names].sort());
      // All eight start before the loop, but never all at once: jsforce's
      // connection pool and the org's per-IP cap would drop the surplus.
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(6);
    });

    it('stops asking once the run is aborted', async () => {
      const names = ['Account', 'Contact', 'Case', 'Lead', 'Opportunity', 'Task', 'Event', 'Asset'];
      deps.isObjectCreatable = vi.fn<CreatableCheck>(async (_orgId, _objectName) => {
        executor.abort();
        return true;
      });
      executor = new ForgeExecutor(deps);

      await expect(
        executor.execute(makeGraph(names.map((name) => makeNode(name))), 'src', 'tgt', onProgress),
      ).rejects.toThrow(ForgeAbortedError);

      // The wave in flight finishes, the next one is never started: without
      // the guard the user waited for every describe of a graph that will not
      // be executed.
      expect(vi.mocked(deps.isObjectCreatable).mock.calls.length).toBeLessThan(names.length);
      expect(deps.insertRecords).not.toHaveBeenCalled();
    });

    it('asks on a dry run as on a real run, and nothing about an excluded object', async () => {
      const check = vi.fn<CreatableCheck>().mockResolvedValue(true);
      deps.isObjectCreatable = check;
      executor = new ForgeExecutor(deps);

      await executor.execute(makeGraph([makeNode('Account')]), 'src', 'tgt', onProgress, {
        dryRun: true,
      });
      expect(check.mock.calls).toEqual([['tgt', 'Account']]);

      check.mockClear();
      await executor.execute(
        makeGraph([makeNode('Account'), makeNode('Contact', { included: false })]),
        'src',
        'tgt',
        onProgress,
      );
      expect(check.mock.calls).toEqual([['tgt', 'Account']]);
    });

    it.each([
      ['a run', false],
      ['a dry run', true],
    ] as const)(
      '%s matches reference data by name in a target that refuses to insert it',
      async (_run, dryRun) => {
        const SOURCE_HOURS = '01m000000000001SRC';
        const TARGET_HOURS = '01m000000000001AAA';
        vi.mocked(deps.queryRecords).mockImplementation(async (orgId) =>
          orgId === 'tgt'
            ? [{ Id: TARGET_HOURS, Name: 'Default' }]
            : [{ Id: SOURCE_HOURS, Name: 'Default' }],
        );
        deps.isObjectCreatable = vi.fn<CreatableCheck>().mockResolvedValue(false);
        executor = new ForgeExecutor(deps);

        const summary = await executor.execute(
          makeGraph([makeNode('BusinessHours')]),
          'src',
          'tgt',
          onProgress,
          { dryRun },
        );

        // Matching writes nothing: the refusal is no reason to leave the rows
        // unmatched, and the records pointing at them without their hours.
        expect(summary.errors).toEqual([]);
        expect(summary.skippedCount).toBe(0);
        expect(summary.linkedCount).toBe(1);
        expect(summary.remapTable).toEqual({ [SOURCE_HOURS]: TARGET_HOURS });
        expect(deps.insertRecords).not.toHaveBeenCalled();
      },
    );
  });

  describe('records the target already holds', () => {
    /** Fake ids: two source Accounts, the Accounts the target holds, and a Contact. */
    const ACCOUNT_SRC_1 = '001Fk00000ZzYxWIAV';
    const ACCOUNT_SRC_2 = '001Fk00000QrStUIAV';
    const EXISTING_15 = '001Fk00000AbCdE';
    const EXISTING_18 = '001Fk00000AbCdEIAV';
    const CONTACT_SRC = '003Fk00000MnOpQIAV';

    const accountToContact: ForgeGraphEdge = {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    };

    /** Account has a unique external key; Contact looks it up through AccountId. */
    function describeAccountAndContact(): void {
      vi.mocked(deps.describeFields).mockImplementation(async (_orgId, objectName) =>
        objectName === 'Account'
          ? [
              { name: 'Id', queryable: true, createable: false, isReference: false },
              { name: 'Name', queryable: true, createable: true, isReference: false },
            ]
          : [
              { name: 'Id', queryable: true, createable: false, isReference: false },
              { name: 'LastName', queryable: true, createable: true, isReference: false },
              {
                name: 'AccountId',
                queryable: true,
                createable: true,
                isReference: true,
                referenceTo: ['Account'],
              },
            ],
      );
      deps.describeObject = vi.fn(async (_orgId: string, objectName: string) => ({
        keyPrefix: objectName === 'Account' ? '001' : '003',
        recordTypes: [],
      }));
      executor = new ForgeExecutor(deps);
    }

    /** The Accounts are refused with `accountErrors`; the Contacts are created. */
    function refuseAccounts(accountErrors: string[]): void {
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objectName, records) =>
        records.map((_, i) =>
          objectName === 'Account'
            ? { id: '', success: false, errors: accountErrors }
            : { id: `003Fk0000000${i}NEW`, success: true, errors: [] },
        ),
      );
    }

    it('links the children of a parent the target refused as a duplicate to the record it named', async () => {
      describeAccountAndContact();
      vi.mocked(deps.queryRecords).mockImplementation(async (_orgId, soql) =>
        soql.includes('FROM Account')
          ? [{ Id: ACCOUNT_SRC_1, Name: 'Acme' }]
          : [{ Id: CONTACT_SRC, LastName: 'Doe', AccountId: ACCOUNT_SRC_1 }],
      );
      refuseAccounts([
        `DUPLICATE_VALUE: duplicate value found: ExternalKey__c duplicates value on record with id: ${EXISTING_15}`,
      ]);
      const graph = makeGraph(
        [makeNode('Account', { recordCount: 1 }), makeNode('Contact', { recordCount: 1 })],
        [accountToContact],
      );

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      const contactPayload = vi
        .mocked(deps.insertRecords)
        .mock.calls.find((c) => c[1] === 'Contact')?.[2];
      expect(contactPayload).toEqual([{ LastName: 'Doe', AccountId: EXISTING_18 }]);
      expect(summary).toMatchObject({
        successCount: 1,
        linkedCount: 1,
        failedCount: 0,
        existingRecords: [{ objectApiName: 'Account', linked: 1, unidentified: 0 }],
        existingSourceIds: [ACCOUNT_SRC_1],
      });
      expect(summary.remapTable[ACCOUNT_SRC_1]).toBe(EXISTING_18);
      expect(summary.errors).toEqual([]);
      const accountDone = progressEvents.filter((e) => e.objectName === 'Account').pop();
      expect(accountDone?.status).toBe('done');
      expect(accountDone?.message).toContain('1 linked to records already in the target');
    });

    it('counts its remap table per object, the linked row apart from the created one', async () => {
      // The table's ids cannot say which object a row belongs to; the run's
      // lineage is drawn from these counts.
      describeAccountAndContact();
      vi.mocked(deps.queryRecords).mockImplementation(async (_orgId, soql) =>
        soql.includes('FROM Account')
          ? [{ Id: ACCOUNT_SRC_1, Name: 'Acme' }]
          : [{ Id: CONTACT_SRC, LastName: 'Doe', AccountId: ACCOUNT_SRC_1 }],
      );
      refuseAccounts([
        `DUPLICATE_VALUE: duplicate value found: ExternalKey__c duplicates value on record with id: ${EXISTING_15}`,
      ]);
      const graph = makeGraph(
        [makeNode('Account', { recordCount: 1 }), makeNode('Contact', { recordCount: 1 })],
        [accountToContact],
      );

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.remapByObject).toEqual([
        { objectApiName: 'Account', created: 0, linked: 1 },
        { objectApiName: 'Contact', created: 1, linked: 0 },
      ]);
      // What removing the run's records may take: the contact, never the
      // account the target already held.
      expect(summary.createdByObject).toEqual([
        { objectApiName: 'Contact', sourceIds: [CONTACT_SRC] },
      ]);
    });

    it('keeps the lookup of a record-scoped child instead of blanking it', async () => {
      // Scoped runs nullify a lookup whose parent has no target id. Before the
      // refusal was read, a parent the target already held had none.
      describeAccountAndContact();
      vi.mocked(deps.queryRecords).mockImplementation(async (_orgId, soql) =>
        soql.includes('FROM Account')
          ? [{ Id: ACCOUNT_SRC_1, Name: 'Acme' }]
          : [{ Id: CONTACT_SRC, LastName: 'Doe', AccountId: ACCOUNT_SRC_1 }],
      );
      refuseAccounts([
        `DUPLICATE_VALUE: duplicate value found: ExternalKey__c duplicates value on record with id: ${EXISTING_15}`,
      ]);
      const graph = makeGraph(
        [makeNode('Account', { recordCount: 1 }), makeNode('Contact', { recordCount: 1 })],
        [accountToContact],
      );

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ACCOUNT_SRC_1,
        rootObjectApiName: 'Account',
      });

      const contactPayload = vi
        .mocked(deps.insertRecords)
        .mock.calls.find((c) => c[1] === 'Contact')?.[2];
      expect(contactPayload?.[0].AccountId).toBe(EXISTING_18);
    });

    it('says which duplicates it could not identify, and still writes their children without the link', async () => {
      describeAccountAndContact();
      vi.mocked(deps.queryRecords).mockImplementation(async (_orgId, soql) =>
        soql.includes('FROM Account')
          ? [
              { Id: ACCOUNT_SRC_1, Name: 'Acme' },
              { Id: ACCOUNT_SRC_2, Name: 'Globex' },
            ]
          : [{ Id: CONTACT_SRC, LastName: 'Doe', AccountId: ACCOUNT_SRC_1 }],
      );
      refuseAccounts([
        'DUPLICATE_VALUE: duplicate value found: <unknown> duplicates value on record with id: <unknown>',
      ]);
      const graph = makeGraph(
        [makeNode('Account', { recordCount: 2 }), makeNode('Contact', { recordCount: 1 })],
        [accountToContact],
      );

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary).toMatchObject({
        linkedCount: 0,
        failedCount: 2,
        skippedCount: 0,
        existingRecords: [{ objectApiName: 'Account', linked: 0, unidentified: 2 }],
        existingSourceIds: [],
      });
      const accountDone = progressEvents.filter((e) => e.objectName === 'Account').pop();
      expect(accountDone?.message).toContain('their children lose the link');
      expect(vi.mocked(deps.insertRecords).mock.calls.some((c) => c[1] === 'Contact')).toBe(true);
    });

    it('does not link to a record of another object', async () => {
      describeAccountAndContact();
      vi.mocked(deps.queryRecords).mockImplementation(async (_orgId, soql) =>
        soql.includes('FROM Account') ? [{ Id: ACCOUNT_SRC_1, Name: 'Acme' }] : [],
      );
      refuseAccounts([
        'DUPLICATE_VALUE: duplicate value found: ExternalKey__c duplicates value on record with id: 003Fk00000MnOpQ',
      ]);

      const summary = await executor.execute(
        makeGraph([makeNode('Account', { recordCount: 1 })]),
        'src',
        'tgt',
        onProgress,
      );

      expect(summary.remapTable).toEqual({});
      expect(summary.existingRecords).toEqual([
        { objectApiName: 'Account', linked: 0, unidentified: 1 },
      ]);
    });

    it('links an orphan parent the target already holds rather than losing the child', async () => {
      const PARENT_SRC = '001Fk00000ZzYxWIAV';
      vi.mocked(deps.describeFields).mockImplementation(async (_orgId, objectName) =>
        objectName === 'Account'
          ? [
              { name: 'Id', queryable: true, createable: false, isReference: false },
              { name: 'Name', queryable: true, createable: true, isReference: false },
            ]
          : [
              { name: 'Id', queryable: true, createable: false, isReference: false },
              { name: 'Name', queryable: true, createable: true, isReference: false },
              {
                name: 'AccountId',
                queryable: true,
                createable: true,
                isReference: true,
                referenceTo: ['Account'],
                nillable: false,
              },
            ],
      );
      deps.describeObject = vi.fn(async () => ({ keyPrefix: '001', recordTypes: [] }));
      vi.mocked(deps.queryRecords).mockImplementation(async (_orgId, soql) =>
        soql.includes('FROM Account')
          ? [{ Id: PARENT_SRC, Name: 'Acme' }]
          : [{ Id: '02iFk00000AsSeTIAV', Name: 'Pump', AccountId: PARENT_SRC }],
      );
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objectName, records) =>
        records.map(() =>
          objectName === 'Account'
            ? {
                id: '',
                success: false,
                errors: [
                  `DUPLICATE_VALUE: duplicate value found: Name duplicates value on record with id: ${EXISTING_15}`,
                ],
              }
            : { id: '02iFk00000NeWaSIAV', success: true, errors: [] },
        ),
      );
      executor = new ForgeExecutor(deps);

      const summary = await executor.execute(
        makeGraph([makeNode('Asset', { recordCount: 1 })]),
        'src',
        'tgt',
        onProgress,
        { expandOrphanParents: true },
      );

      const assetPayload = vi
        .mocked(deps.insertRecords)
        .mock.calls.find((c) => c[1] === 'Asset')?.[2];
      expect(assetPayload?.[0].AccountId).toBe(EXISTING_18);
      expect(summary.existingSourceIds).toEqual([PARENT_SRC]);
    });
  });

  describe('record type availability', () => {
    const ROOT_ID = '500Fk00000CaSeAIAV';
    const SOURCE_RT = '012Fk00000RtGhIIAV';
    const PARTNER_RT = '012Fk00000RtDeFIAV';
    const CUSTOMER_RT = '012Fk00000RtAbCIAV';

    /** The target's Case record types, as the running user sees them. */
    const CASE_RECORD_TYPES = [
      {
        recordTypeId: CUSTOMER_RT,
        developerName: 'Customer_Case',
        name: 'Customer Case',
        available: true,
        active: true,
        master: false,
        defaultRecordTypeMapping: true,
      },
      {
        recordTypeId: PARTNER_RT,
        developerName: 'Partner_Case',
        name: 'Partner Case',
        available: false,
        active: true,
        master: false,
        defaultRecordTypeMapping: false,
      },
    ];

    const caseToComment: ForgeGraphEdge = {
      sourceObject: 'Case',
      targetObject: 'CaseComment',
      relationshipName: 'CaseComments',
      type: 'master-detail',
    };

    function describeCaseWithRecordTypes(): void {
      vi.mocked(deps.describeFields).mockImplementation(async (_orgId, objectName) =>
        objectName === 'Case'
          ? [
              { name: 'Id', queryable: true, createable: false, isReference: false },
              { name: 'Subject', queryable: true, createable: true, isReference: false },
              {
                name: 'RecordTypeId',
                queryable: true,
                createable: true,
                isReference: true,
                referenceTo: ['RecordType'],
              },
            ]
          : [
              { name: 'Id', queryable: true, createable: false, isReference: false },
              {
                name: 'ParentId',
                queryable: true,
                createable: true,
                isReference: true,
                referenceTo: ['Case'],
              },
            ],
      );
      vi.mocked(deps.queryRecords).mockImplementation(async (_orgId, soql) =>
        soql.includes('FROM Case ')
          ? [
              { Id: ROOT_ID, Subject: 'A', RecordTypeId: SOURCE_RT },
              { Id: '500Fk00000CaSeBIAV', Subject: 'B', RecordTypeId: SOURCE_RT },
            ]
          : [{ Id: '00aFk00000CoMmTIAV', ParentId: ROOT_ID }],
      );
      deps.describeObject = vi.fn(async (_orgId: string, objectName: string) => ({
        keyPrefix: objectName === 'Case' ? '500' : '00a',
        recordTypes: objectName === 'Case' ? CASE_RECORD_TYPES : [],
      }));
      executor = new ForgeExecutor(deps);
    }

    it('holds back an object whose mapped record type the running user cannot use, before writing any of it', async () => {
      describeCaseWithRecordTypes();
      const graph = makeGraph([makeNode('Case'), makeNode('CaseComment')], [caseToComment]);

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
        recordTypeMappings: [
          { sourceId: SOURCE_RT, targetId: PARTNER_RT, developerName: 'Partner_Case' },
        ],
      });

      expect(deps.insertRecords).not.toHaveBeenCalled();
      expect(summary.errors).toContainEqual({
        objectApiName: 'Case',
        stage: 'scope',
        failedCount: 2,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: 'RecordType=Partner_Case (2 records)',
            messages: [
              'RECORD_TYPE_UNAVAILABLE: 2 Case records use record type Partner_Case (Partner Case), ' +
                'which the running user cannot use in the target org. Give the running user access ' +
                'to record type Partner_Case on Case, or map it to one they have.',
            ],
          },
        ],
      });
      expect(summary.failedCount).toBe(2);
      const caseEnd = progressEvents.filter((e) => e.objectName === 'Case').pop();
      expect(caseEnd?.status).toBe('error');
      expect(caseEnd?.message).toContain('Held back Case');
      expect(
        progressEvents.find((e) => e.objectName === 'CaseComment' && e.status === 'skipped')
          ?.message,
      ).toContain('parent failed');
    });

    it('writes the object when every record type it uses is open to the running user', async () => {
      describeCaseWithRecordTypes();
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objectName, records) =>
        records.map((_, i) => ({ id: `500Fk0000000${i}NEW`, success: true, errors: [] })),
      );

      const summary = await executor.execute(
        makeGraph([makeNode('Case')]),
        'src',
        'tgt',
        onProgress,
        {
          rootRecordId: ROOT_ID,
          rootObjectApiName: 'Case',
          recordTypeMappings: [
            { sourceId: SOURCE_RT, targetId: CUSTOMER_RT, developerName: 'Customer_Case' },
          ],
        },
      );

      expect(summary.successCount).toBe(2);
      const written = vi.mocked(deps.insertRecords).mock.calls[0]![2];
      expect(written.map((r) => r.RecordTypeId)).toEqual([CUSTOMER_RT, CUSTOMER_RT]);
    });

    it('lets the platform choose when the run excludes RecordTypeId for the object', async () => {
      describeCaseWithRecordTypes();
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objectName, records) =>
        records.map((_, i) => ({ id: `500Fk0000000${i}NEW`, success: true, errors: [] })),
      );

      const summary = await executor.execute(
        makeGraph([makeNode('Case')]),
        'src',
        'tgt',
        onProgress,
        {
          rootRecordId: ROOT_ID,
          rootObjectApiName: 'Case',
          recordTypeMappings: [
            { sourceId: SOURCE_RT, targetId: PARTNER_RT, developerName: 'Partner_Case' },
          ],
          fieldExclusions: { Case: ['RecordTypeId'] },
        },
      );

      expect(summary.successCount).toBe(2);
      const written = vi.mocked(deps.insertRecords).mock.calls[0]![2];
      expect(written.every((r) => !('RecordTypeId' in r))).toBe(true);
    });

    it('writes as before when the run cannot read the target record types', async () => {
      describeCaseWithRecordTypes();
      deps.describeObject = vi.fn(async () => {
        throw new Error('describe blocked');
      });
      executor = new ForgeExecutor(deps);
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, _objectName, records) =>
        records.map((_, i) => ({ id: `500Fk0000000${i}NEW`, success: true, errors: [] })),
      );

      const summary = await executor.execute(
        makeGraph([makeNode('Case')]),
        'src',
        'tgt',
        onProgress,
        {
          rootRecordId: ROOT_ID,
          rootObjectApiName: 'Case',
          recordTypeMappings: [
            { sourceId: SOURCE_RT, targetId: PARTNER_RT, developerName: 'Partner_Case' },
          ],
        },
      );

      expect(summary.successCount).toBe(2);
    });
  });
});
