import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForgeExecutor, ForgeAbortedError } from './ForgeExecutor.js';
import { partialSummaryOf } from './interruptedRun.js';
import type { ForgeExecutorDeps, ForgeProgressEvent, FieldInfo } from './ForgeExecutor.js';
import type { ForgeGraph, ForgeGraphNode, ForgeGraphEdge } from '@sandforge/shared';
import { logger } from '../../logger.js';

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

    it('should mark children as skipped when parent completely fails', async () => {
      vi.mocked(deps.insertRecords).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return [
            { id: '', success: false, errors: ['FAIL'] },
            { id: '', success: false, errors: ['FAIL'] },
          ];
        }
        return [{ id: '003NEW', success: true, errors: [] }];
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
      const accountToContact: ForgeGraphEdge = {
        sourceObject: 'Account',
        targetObject: 'Contact',
        relationshipName: 'Contacts',
        type: 'lookup',
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

      const entryQueries = vi
        .mocked(deps.queryRecords)
        .mock.calls.filter(([, soql]) => soql.includes('FROM Entry'));
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

      const taskQueries = vi
        .mocked(deps.queryRecords)
        .mock.calls.map((c) => c[1])
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
      vi.mocked(deps.queryRecords).mockImplementation(async () => {
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
      expect(summary.successCount).toBe(1);
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

    it('asks nothing on a dry run or about an excluded object', async () => {
      const check = vi.fn<CreatableCheck>().mockResolvedValue(true);
      deps.isObjectCreatable = check;
      executor = new ForgeExecutor(deps);

      await executor.execute(makeGraph([makeNode('Account')]), 'src', 'tgt', onProgress, {
        dryRun: true,
      });
      expect(check).not.toHaveBeenCalled();

      await executor.execute(
        makeGraph([makeNode('Account'), makeNode('Contact', { included: false })]),
        'src',
        'tgt',
        onProgress,
      );
      expect(check.mock.calls).toEqual([['tgt', 'Account']]);
    });
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
