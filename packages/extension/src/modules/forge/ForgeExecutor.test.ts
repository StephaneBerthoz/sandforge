import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeExecutor } from './ForgeExecutor.js';
import type { ForgeExecutorDeps, ForgeProgressEvent, FieldInfo } from './ForgeExecutor.js';
import type { ForgeGraph, ForgeGraphNode, ForgeGraphEdge } from '@sandforge/shared';

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

function makeGraph(
  nodes: ForgeGraphNode[],
  edges: ForgeGraphEdge[] = [],
): ForgeGraph {
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
      expect(deps.queryRecords).toHaveBeenCalledWith('src', 'SELECT Id, Name FROM Account');
    });

    it('should insert only createable fields into target org', async () => {
      const graph = makeGraph([makeNode('Account')]);
      await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(deps.insertRecords).toHaveBeenCalledWith(
        'tgt',
        'Account',
        [
          { Name: 'Record 1' },
          { Name: 'Record 2' },
        ],
      );
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
        [{ sourceObject: 'Account', targetObject: 'Contact', relationshipName: 'Contacts', type: 'lookup' }],
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
        [{ sourceObject: 'Account', targetObject: 'Contact', relationshipName: 'Contacts', type: 'lookup' }],
      );

      await executor.execute(graph, 'src', 'tgt', onProgress);

      // Second insertRecords call (Contact) should have remapped AccountId
      const contactInsertCall = vi.mocked(deps.insertRecords).mock.calls.find(
        (call) => call[1] === 'Contact',
      );
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
        [{ sourceObject: 'Account', targetObject: 'Contact', relationshipName: 'Contacts', type: 'lookup' }],
      );

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

      expect(summary.skippedCount).toBe(1); // Contact skipped
      expect(summary.failedCount).toBe(2); // Account records
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
    it('should apply anonymization before insert', async () => {
      const anonymize = vi.fn((records: Record<string, unknown>[]) => {
        return records.map((r) => ({ ...r, Name: 'ANON' }));
      });

      const depsWithAnon: ForgeExecutorDeps = {
        ...createMockDeps(),
        anonymize,
      };
      const anonExecutor = new ForgeExecutor(depsWithAnon);

      const graph = makeGraph([makeNode('Account')]);
      await anonExecutor.execute(graph, 'src', 'tgt', onProgress);

      expect(anonymize).toHaveBeenCalledTimes(1);
      expect(anonymize).toHaveBeenCalledWith(
        expect.any(Array),
        'Account',
      );

      // Verify inserted records have anonymized names
      const insertCall = vi.mocked(depsWithAnon.insertRecords).mock.calls[0];
      expect(insertCall[2][0].Name).toBe('ANON');
    });

    it('should not call anonymize when not configured', async () => {
      const graph = makeGraph([makeNode('Account')]);
      await executor.execute(graph, 'src', 'tgt', onProgress);

      // No anonymize in default deps, should still work
      expect(deps.insertRecords).toHaveBeenCalledTimes(1);
    });
  });

  describe('pause and resume', () => {
    it('should support pause and resume', async () => {
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

      const summary = await executor.execute(graph, 'src', 'tgt', onProgress);

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

      // Abort should cause the error to be caught and reported
      await executor.execute(graph, 'src', 'tgt', onProgress);

      // The abort happens after first batch, so second batch should not be processed
      // The error catch in execute adds node.recordCount to failedCount
      const errorEvents = progressEvents.filter((e) => e.status === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect(errorEvents[0].message).toContain('aborted');
    });
  });

  describe('record-scoped mode', () => {
    const ROOT_ID = '500AP00000fXeQsYAK';

    it('should query the root with WHERE Id = ? when rootRecordId is provided', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, Subject: 'Test', AccountId: '001AAA' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'Subject', queryable: true, createable: true, isReference: false },
        { name: 'AccountId', queryable: true, createable: true, isReference: true, referenceTo: ['Account'] },
      ]);

      await executor.execute(graph, 'src', 'tgt', onProgress, {
        rootRecordId: ROOT_ID,
        rootObjectApiName: 'Case',
      });

      expect(deps.queryRecords).toHaveBeenCalledWith(
        'src',
        `SELECT Id, Subject, AccountId FROM Case WHERE Id = '${ROOT_ID}'`,
      );
    });

    it('should skip nodes that are out of scope', async () => {
      const graph = makeGraph(
        [makeNode('Case'), makeNode('Product2')],
        [],
      );
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

    it('should propagate FK values from root to seed parent cache for multi-hop scope', async () => {
      const graph = makeGraph(
        [makeNode('Case'), makeNode('Account')],
        [
          { sourceObject: 'Account', targetObject: 'Case', relationshipName: 'Account', type: 'lookup' },
        ],
      );
      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Case') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            { name: 'AccountId', queryable: true, createable: true, isReference: true, referenceTo: ['Account'] },
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

    it('should bring the root to the front of topo order regardless of cycle bucketing', async () => {
      const graph = makeGraph(
        [makeNode('Case'), makeNode('Account')],
        // cycle: each references the other
        [
          { sourceObject: 'Account', targetObject: 'Case', relationshipName: 'Account', type: 'lookup' },
          { sourceObject: 'Case', targetObject: 'Account', relationshipName: 'Cases', type: 'lookup' },
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

  describe('dryRun mode', () => {
    const ROOT_ID = '500AP00000fXeQsYAK';

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
          { sourceObject: 'Case', targetObject: 'CaseHistory', relationshipName: 'Histories', type: 'lookup' },
        ],
      );
      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Case') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
          ];
        }
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'CaseId', queryable: true, createable: true, isReference: true, referenceTo: ['Case'] },
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
});
