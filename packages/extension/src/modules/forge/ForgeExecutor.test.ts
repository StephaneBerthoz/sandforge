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

  describe('Wave 2 v3 — 2-pass cycle FK update', () => {
    const ROOT_ID = '500AP00000fXeQsYAK';

    it('issues a pass-2 UPDATE for FKs nullified during pass-1 insert', async () => {
      const updateRecords = vi.fn<NonNullable<ForgeExecutorDeps['updateRecords']>>().mockResolvedValue([
        { id: '001NEW1', success: true, errors: [] },
      ]);
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
          { sourceObject: 'Contact', targetObject: 'Account', relationshipName: 'PrimaryContact', type: 'lookup' },
          { sourceObject: 'Account', targetObject: 'Contact', relationshipName: 'Contacts', type: 'lookup' },
        ],
      );

      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Account') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            { name: 'PrimaryContactId', queryable: true, createable: true, isReference: true, referenceTo: ['Contact'] },
          ];
        }
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'AccountId', queryable: true, createable: true, isReference: true, referenceTo: ['Account'] },
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
      const updateRecords = vi.fn<NonNullable<ForgeExecutorDeps['updateRecords']>>().mockResolvedValue([]);
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
      const updateRecords = vi.fn<NonNullable<ForgeExecutorDeps['updateRecords']>>().mockResolvedValue([
        { id: '001NEW1', success: true, errors: [] },
      ]);
      const cycleExecutor = new ForgeExecutor({ ...deps, updateRecords });

      // Account has two FKs both pointing at Contact: PrimaryContactId AND
      // Backup_Contact__c. Both get nullified at insert (Contact not yet
      // cloned), then both must be patched in pass 2 — but in a single
      // UPDATE call to the same Account record.
      const graph = makeGraph(
        [makeNode('Account'), makeNode('Contact')],
        [
          { sourceObject: 'Contact', targetObject: 'Account', relationshipName: 'PrimaryContact', type: 'lookup' },
          { sourceObject: 'Account', targetObject: 'Contact', relationshipName: 'Contacts', type: 'lookup' },
        ],
      );

      vi.mocked(deps.describeFields).mockImplementation(async (_o, name) => {
        if (name === 'Account') {
          return [
            { name: 'Id', queryable: true, createable: false, isReference: false },
            { name: 'PrimaryContactId', queryable: true, createable: true, isReference: true, referenceTo: ['Contact'] },
            { name: 'Backup_Contact__c', queryable: true, createable: true, isReference: true, referenceTo: ['Contact'] },
          ];
        }
        return [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'AccountId', queryable: true, createable: true, isReference: true, referenceTo: ['Account'] },
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
        rootRecordId: '500AP00000fXeQsYAK',
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
      const updateRecords = vi.fn<NonNullable<ForgeExecutorDeps['updateRecords']>>().mockResolvedValue([]);
      const depsCycle: ForgeExecutorDeps = { ...deps, updateRecords };
      const cycleExecutor = new ForgeExecutor(depsCycle);

      const graph = makeGraph([makeNode('Account')]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'PrimaryContactId', queryable: true, createable: true, isReference: true, referenceTo: ['Contact'] },
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

  describe('orphan FK handling (referenceFallback)', () => {
    const ROOT_ID = '500AP00000fXeQsYAK';

    it('omits reference fields whose value is not in the remapper (default in scoped mode)', async () => {
      const graph = makeGraph([makeNode('Case')]);
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, OwnerId: '005USER1', AccountId: '001UNCLONED' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'OwnerId', queryable: true, createable: true, isReference: true, referenceTo: ['User'] },
        { name: 'AccountId', queryable: true, createable: true, isReference: true, referenceTo: ['Account'] },
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
        { name: 'RecordTypeId', queryable: true, createable: true, isReference: true, referenceTo: ['RecordType'] },
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
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, OwnerId: '005USER1' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'OwnerId', queryable: true, createable: true, isReference: true, referenceTo: ['User'] },
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
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, OwnerId: '005USER1' },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'OwnerId', queryable: true, createable: true, isReference: true, referenceTo: ['User'] },
      ]);

      // No options → legacy mode
      await executor.execute(graph, 'src', 'tgt', onProgress);

      const inserted = vi.mocked(deps.insertRecords).mock.calls[0]![2][0];
      expect(inserted.OwnerId).toBe('005USER1');
    });
  });

  describe('maxRecordsPerObject (sampling cap)', () => {
    const ROOT_ID = '500AP00000fXeQsYAK';

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
    const ROOT_ID = '500AP00000fXeQsYAK';
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
        { name: 'RecordTypeId', queryable: true, createable: true, isReference: true, referenceTo: ['RecordType'] },
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
      vi.mocked(deps.queryRecords).mockResolvedValue([
        { Id: ROOT_ID, RecordTypeId: SOURCE_RT },
      ]);
      vi.mocked(deps.describeFields).mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        { name: 'RecordTypeId', queryable: true, createable: true, isReference: true, referenceTo: ['RecordType'] },
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
        { name: 'RecordTypeId', queryable: true, createable: true, isReference: true, referenceTo: ['RecordType'] },
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
