import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphDiscoveryService } from './GraphDiscoveryService.js';
import type { GraphDiscoveryDeps, ObjectDescribe } from './GraphDiscoveryService.js';
import type { ForgeConfig } from '@sandforge/shared';

function createMockDeps(): GraphDiscoveryDeps {
  return {
    describeObject: vi.fn<GraphDiscoveryDeps['describeObject']>().mockResolvedValue({
      name: 'Account',
      fields: [
        { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
        { name: 'Name', type: 'string', referenceTo: [], relationshipName: null, isMasterDetail: false },
      ],
      childRelationships: [],
    }),
    queryCount: vi.fn<GraphDiscoveryDeps['queryCount']>().mockResolvedValue(10),
    detectPII: vi.fn<GraphDiscoveryDeps['detectPII']>().mockReturnValue([]),
    describeGlobal: vi.fn<GraphDiscoveryDeps['describeGlobal']>().mockResolvedValue([
      { name: 'Account', keyPrefix: '001' },
      { name: 'Contact', keyPrefix: '003' },
      { name: 'Opportunity', keyPrefix: '006' },
      { name: 'Lead', keyPrefix: '00Q' },
      { name: 'Case', keyPrefix: '500' },
      { name: 'CustomObj__c', keyPrefix: 'a0B' },
    ]),
  };
}

function createConfig(overrides?: Partial<ForgeConfig>): ForgeConfig {
  return {
    inputMode: 'record',
    recordId: '001XXXXXXXXXX',
    depth: 'direct',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
    ...overrides,
  };
}

function makeAccountDescribe(children: ObjectDescribe['childRelationships'] = []): ObjectDescribe {
  return {
    name: 'Account',
    fields: [
      { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
      { name: 'Name', type: 'string', referenceTo: [], relationshipName: null, isMasterDetail: false },
    ],
    childRelationships: children,
  };
}

function makeContactDescribe(): ObjectDescribe {
  return {
    name: 'Contact',
    fields: [
      { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
      { name: 'AccountId', type: 'reference', referenceTo: ['Account'], relationshipName: 'Account', isMasterDetail: false },
      { name: 'Email', type: 'email', referenceTo: [], relationshipName: null, isMasterDetail: false },
    ],
    childRelationships: [],
  };
}

describe('GraphDiscoveryService', () => {
  let deps: GraphDiscoveryDeps;
  let service: GraphDiscoveryService;

  beforeEach(() => {
    deps = createMockDeps();
    service = new GraphDiscoveryService(deps);
  });

  describe('discover from record ID', () => {
    it('should resolve root object from record ID prefix via describeGlobal', async () => {
      const config = createConfig({ recordId: '001XXXXXXXXXX' });
      const graph = await service.discover(config);
      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0].objectApiName).toBe('Account');
      expect(deps.describeGlobal).toHaveBeenCalledWith('src-org');
    });

    it('should resolve custom object prefix via describeGlobal', async () => {
      const config = createConfig({ recordId: 'a0BXXXXXXXXXX' });
      vi.mocked(deps.describeObject).mockResolvedValue({
        name: 'CustomObj__c',
        fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
        childRelationships: [],
      });

      const graph = await service.discover(config);
      expect(graph.nodes[0].objectApiName).toBe('CustomObj__c');
    });

    it('should throw when record ID prefix is not found in describeGlobal', async () => {
      const config = createConfig({ recordId: 'ZZZXXXXXXXXXX' });
      await expect(service.discover(config)).rejects.toThrow(
        'No object found for record ID prefix "ZZZ"',
      );
    });

    it('should query record count for the root object', async () => {
      const config = createConfig({ recordId: '003XXXXXXXXXX' });
      vi.mocked(deps.describeObject).mockResolvedValue({
        name: 'Contact',
        fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
        childRelationships: [],
      });
      vi.mocked(deps.queryCount).mockResolvedValue(42);

      const graph = await service.discover(config);
      expect(graph.nodes[0].recordCount).toBe(42);
      expect(deps.queryCount).toHaveBeenCalledWith('src-org', 'SELECT COUNT() FROM Contact');
    });
  });

  describe('discover from SOQL', () => {
    it('should parse object name from SOQL query', async () => {
      const config = createConfig({
        inputMode: 'soql',
        soqlQuery: 'SELECT Id, Name FROM Opportunity WHERE Amount > 1000',
        recordId: undefined,
      });
      vi.mocked(deps.describeObject).mockResolvedValue({
        name: 'Opportunity',
        fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
        childRelationships: [],
      });

      const graph = await service.discover(config);
      expect(graph.nodes[0].objectApiName).toBe('Opportunity');
    });

    it('should handle lowercase FROM keyword', async () => {
      const config = createConfig({
        inputMode: 'soql',
        soqlQuery: 'select Id from Lead',
        recordId: undefined,
      });
      vi.mocked(deps.describeObject).mockResolvedValue({
        name: 'Lead',
        fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
        childRelationships: [],
      });

      const graph = await service.discover(config);
      expect(graph.nodes[0].objectApiName).toBe('Lead');
    });
  });

  describe('depth traversal', () => {
    it('should traverse child relationships with depth=direct (1 level)', async () => {
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return makeAccountDescribe([{
            childSObject: 'Contact',
            field: 'AccountId',
            relationshipName: 'Contacts',
            isCascadeDelete: false,
          }]);
        }
        return makeContactDescribe();
      });

      const config = createConfig({ depth: 'direct' });
      const graph = await service.discover(config);

      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes.map((n) => n.objectApiName)).toContain('Account');
      expect(graph.nodes.map((n) => n.objectApiName)).toContain('Contact');
    });

    it('should not traverse beyond depth limit with depth=direct', async () => {
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return makeAccountDescribe([{
            childSObject: 'Contact',
            field: 'AccountId',
            relationshipName: 'Contacts',
            isCascadeDelete: false,
          }]);
        }
        // Contact has a child Task, but we are at depth 1 — should not go deeper
        return {
          name: 'Contact',
          fields: [
            { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
          ],
          childRelationships: [{
            childSObject: 'Task',
            field: 'WhoId',
            relationshipName: 'Tasks',
            isCascadeDelete: false,
          }],
        };
      });

      const config = createConfig({ depth: 'direct' });
      const graph = await service.discover(config);

      const objectNames = graph.nodes.map((n) => n.objectApiName);
      expect(objectNames).toContain('Account');
      expect(objectNames).toContain('Contact');
      expect(objectNames).not.toContain('Task');
    });

    it('should traverse deeper with depth=full (max 5)', async () => {
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return makeAccountDescribe([{
            childSObject: 'Contact',
            field: 'AccountId',
            relationshipName: 'Contacts',
            isCascadeDelete: false,
          }]);
        }
        if (objectName === 'Contact') {
          return {
            name: 'Contact',
            fields: [
              { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
            ],
            childRelationships: [{
              childSObject: 'Task',
              field: 'WhoId',
              relationshipName: 'Tasks',
              isCascadeDelete: false,
            }],
          };
        }
        return {
          name: objectName,
          fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
          childRelationships: [],
        };
      });

      const config = createConfig({ depth: 'full' });
      const graph = await service.discover(config);

      const objectNames = graph.nodes.map((n) => n.objectApiName);
      expect(objectNames).toContain('Account');
      expect(objectNames).toContain('Contact');
      expect(objectNames).toContain('Task');
    });

    it('should use customDepth when depth=custom', async () => {
      vi.mocked(deps.describeObject).mockResolvedValue({
        name: 'Account',
        fields: [],
        childRelationships: [],
      });

      const config = createConfig({ depth: 'custom', customDepth: 2 });
      const graph = await service.discover(config);

      // Only root, no children to discover
      expect(graph.nodes).toHaveLength(1);
    });
  });

  describe('PII detection', () => {
    it('should detect PII fields via deps.detectPII', async () => {
      vi.mocked(deps.detectPII).mockReturnValue(['Email', 'Phone']);

      const config = createConfig();
      const graph = await service.discover(config);

      expect(graph.nodes[0].piiFields).toEqual(['Email', 'Phone']);
      expect(deps.detectPII).toHaveBeenCalledTimes(1);
    });

    it('should populate anonymizeFields when anonymizePII is true', async () => {
      vi.mocked(deps.detectPII).mockReturnValue(['Email']);

      const config = createConfig({ anonymizePII: true });
      const graph = await service.discover(config);

      expect(graph.nodes[0].anonymizeFields).toEqual(['Email']);
    });

    it('should leave anonymizeFields empty when anonymizePII is false', async () => {
      vi.mocked(deps.detectPII).mockReturnValue(['Email']);

      const config = createConfig({ anonymizePII: false });
      const graph = await service.discover(config);

      expect(graph.nodes[0].anonymizeFields).toEqual([]);
    });
  });

  describe('edges', () => {
    it('should create edges for lookup fields', async () => {
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return makeAccountDescribe([{
            childSObject: 'Contact',
            field: 'AccountId',
            relationshipName: 'Contacts',
            isCascadeDelete: false,
          }]);
        }
        return makeContactDescribe();
      });

      const config = createConfig({ depth: 'direct' });
      const graph = await service.discover(config);

      expect(graph.edges.length).toBeGreaterThan(0);
      const childEdge = graph.edges.find(
        (e) => e.sourceObject === 'Account' && e.targetObject === 'Contact',
      );
      expect(childEdge).toBeDefined();
      expect(childEdge?.relationshipName).toBe('Contacts');
      expect(childEdge?.type).toBe('lookup');
    });

    it('should mark master-detail edges from child relationships', async () => {
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return makeAccountDescribe([{
            childSObject: 'Contact',
            field: 'AccountId',
            relationshipName: 'Contacts',
            isCascadeDelete: true,
          }]);
        }
        return makeContactDescribe();
      });

      const config = createConfig({ depth: 'direct' });
      const graph = await service.discover(config);

      const mdEdge = graph.edges.find(
        (e) => e.sourceObject === 'Account' && e.targetObject === 'Contact' && e.relationshipName === 'Contacts',
      );
      expect(mdEdge?.type).toBe('master-detail');
    });
  });

  describe('estimates', () => {
    it('should calculate total records across all nodes', async () => {
      vi.mocked(deps.describeObject).mockResolvedValue(makeAccountDescribe());
      vi.mocked(deps.queryCount).mockResolvedValue(100);

      const config = createConfig();
      const graph = await service.discover(config);

      expect(graph.totalRecords).toBe(100);
    });

    it('should estimate size and duration from record counts', async () => {
      vi.mocked(deps.queryCount).mockResolvedValue(1000);

      const config = createConfig();
      const graph = await service.discover(config);

      expect(graph.estimatedSizeMB).toBeCloseTo(1.0);
      expect(graph.estimatedDurationSeconds).toBeCloseTo(10.0);
    });
  });

  describe('skipEmpty', () => {
    it('should mark nodes with zero records as excluded when skipEmpty is true', async () => {
      vi.mocked(deps.queryCount).mockResolvedValue(0);

      const config = createConfig({ skipEmpty: true });
      const graph = await service.discover(config);

      expect(graph.nodes[0].included).toBe(false);
    });

    it('should include nodes with zero records when skipEmpty is false', async () => {
      vi.mocked(deps.queryCount).mockResolvedValue(0);

      const config = createConfig({ skipEmpty: false });
      const graph = await service.discover(config);

      expect(graph.nodes[0].included).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw for unsupported input mode without recordId or soqlQuery', async () => {
      const config = createConfig({ inputMode: 'template', recordId: undefined });
      await expect(service.discover(config)).rejects.toThrow('Cannot resolve root object');
    });
  });

  describe('guardrails', () => {
    it('should exclude system suffix objects from traversal', async () => {
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return makeAccountDescribe([
            { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts', isCascadeDelete: false },
            { childSObject: 'AccountHistory', field: 'AccountId', relationshipName: 'Histories', isCascadeDelete: false },
            { childSObject: 'AccountFeed', field: 'ParentId', relationshipName: 'Feeds', isCascadeDelete: false },
            { childSObject: 'AccountShare', field: 'AccountId', relationshipName: 'Shares', isCascadeDelete: false },
          ]);
        }
        return makeContactDescribe();
      });

      const config = createConfig({ depth: 'direct' });
      const graph = await service.discover(config);

      const objectNames = graph.nodes.map((n) => n.objectApiName);
      expect(objectNames).toContain('Account');
      expect(objectNames).toContain('Contact');
      expect(objectNames).not.toContain('AccountHistory');
      expect(objectNames).not.toContain('AccountFeed');
      expect(objectNames).not.toContain('AccountShare');
    });

    it('should exclude hub objects like User and RecordType from traversal', async () => {
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return {
            name: 'Account',
            fields: [
              { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
              { name: 'OwnerId', type: 'reference', referenceTo: ['User'], relationshipName: 'Owner', isMasterDetail: false },
              { name: 'RecordTypeId', type: 'reference', referenceTo: ['RecordType'], relationshipName: 'RecordType', isMasterDetail: false },
            ],
            childRelationships: [],
          };
        }
        return { name: objectName, fields: [], childRelationships: [] };
      });

      const config = createConfig({ depth: 'direct' });
      const graph = await service.discover(config);

      const objectNames = graph.nodes.map((n) => n.objectApiName);
      expect(objectNames).toContain('Account');
      expect(objectNames).not.toContain('User');
      expect(objectNames).not.toContain('RecordType');
    });

    it('should still create edges to excluded objects without visiting them', async () => {
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return {
            name: 'Account',
            fields: [
              { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
              { name: 'OwnerId', type: 'reference', referenceTo: ['User'], relationshipName: 'Owner', isMasterDetail: false },
            ],
            childRelationships: [],
          };
        }
        return { name: objectName, fields: [], childRelationships: [] };
      });

      const config = createConfig({ depth: 'direct' });
      const graph = await service.discover(config);

      const userEdge = graph.edges.find((e) => e.targetObject === 'User');
      expect(userEdge).toBeDefined();
      expect(graph.nodes.find((n) => n.objectApiName === 'User')).toBeUndefined();
    });

    it('should stop discovering when max nodes cap is reached', async () => {
      // Create a wide graph: each object has 10 children so depth limit isn't the bottleneck
      let objCounter = 0;
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        const children = [];
        for (let i = 0; i < 10; i++) {
          objCounter++;
          children.push({
            childSObject: `Obj${objCounter}`,
            field: 'ParentId',
            relationshipName: `Children${i}`,
            isCascadeDelete: false,
          });
        }
        return {
          name: objectName,
          fields: [
            { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
          ],
          childRelationships: children,
        };
      });

      const config = createConfig({ depth: 'full' });
      const graph = await service.discover(config);

      // DEFAULT_MAX_NODES is 50 — the cap should be the actual limiter, not depth
      expect(graph.nodes.length).toBe(50);
    });
  });

  describe('abort signal', () => {
    it('should stop discovery when signal is aborted', async () => {
      const controller = new AbortController();
      let describeCallCount = 0;

      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        describeCallCount++;
        if (describeCallCount === 1) {
          controller.abort();
        }
        return {
          name: objectName,
          fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
          childRelationships: [{
            childSObject: `Child${describeCallCount}`,
            field: 'ParentId',
            relationshipName: 'Children',
            isCascadeDelete: false,
          }],
        };
      });

      const config = createConfig({ depth: 'full' });
      const graph = await service.discover(config, { signal: controller.signal });

      expect(graph.nodes.length).toBe(1);
    });

    it('should return partial graph when aborted', async () => {
      const controller = new AbortController();
      let callCount = 0;

      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        callCount++;
        if (callCount === 2) {
          controller.abort();
        }
        if (objectName === 'Account') {
          return makeAccountDescribe([
            { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts', isCascadeDelete: false },
            { childSObject: 'Opportunity', field: 'AccountId', relationshipName: 'Opportunities', isCascadeDelete: false },
          ]);
        }
        return {
          name: objectName,
          fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
          childRelationships: [],
        };
      });

      const config = createConfig({ depth: 'direct' });
      const graph = await service.discover(config, { signal: controller.signal });

      // Account + Contact discovered, then aborted before Opportunity
      expect(graph.nodes.length).toBe(2);
      expect(graph.totalRecords).toBe(20);
    });
  });

  describe('progress callback', () => {
    it('should call onProgress for each discovered node', async () => {
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        if (objectName === 'Account') {
          return makeAccountDescribe([{
            childSObject: 'Contact',
            field: 'AccountId',
            relationshipName: 'Contacts',
            isCascadeDelete: false,
          }]);
        }
        return makeContactDescribe();
      });

      const onProgress = vi.fn();
      const config = createConfig({ depth: 'direct' });
      await service.discover(config, { onProgress });

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenCalledWith({
        objectApiName: 'Account',
        discoveredCount: 1,
        queueRemaining: 1,
      });
      expect(onProgress).toHaveBeenCalledWith({
        objectApiName: 'Contact',
        discoveredCount: 2,
        queueRemaining: 0,
      });
    });

    it('should work without onProgress callback', async () => {
      const config = createConfig();
      const graph = await service.discover(config, {});
      expect(graph.nodes).toHaveLength(1);
    });
  });

  describe('maxNodes override', () => {
    it('should respect custom maxNodes option', async () => {
      let objCounter = 0;
      vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
        const children = [];
        for (let i = 0; i < 5; i++) {
          objCounter++;
          children.push({
            childSObject: `Obj${objCounter}`,
            field: 'ParentId',
            relationshipName: `Children${i}`,
            isCascadeDelete: false,
          });
        }
        return {
          name: objectName,
          fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
          childRelationships: children,
        };
      });

      const config = createConfig({ depth: 'full' });
      const graph = await service.discover(config, { maxNodes: 10 });

      expect(graph.nodes.length).toBe(10);
    });
  });
});
