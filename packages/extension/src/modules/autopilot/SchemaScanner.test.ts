import { describe, it, expect, vi } from 'vitest';
import { SchemaScanner } from './SchemaScanner';
import type {
  AutopilotConnection,
  ObjectDescribeResult,
  GlobalDescribeResult,
  GlobalSObjectDescribe,
  FieldDescribeResult,
} from './SchemaScanner';

/** Helper: create a minimal field describe. */
function mockField(
  overrides: Partial<FieldDescribeResult> & { name: string },
): FieldDescribeResult {
  return {
    label: overrides.name,
    type: 'string',
    nillable: true,
    createable: true,
    updateable: true,
    unique: false,
    externalId: false,
    referenceTo: [],
    relationshipName: null,
    defaultValue: null,
    ...overrides,
  };
}

/** Helper: create a lookup field. */
function lookupField(
  name: string,
  referenceTo: string[],
  relationshipName: string | null = null,
): FieldDescribeResult {
  return mockField({
    name,
    type: 'reference',
    referenceTo,
    relationshipName,
  });
}

/** Helper: create an object describe result. */
function mockDescribe(
  name: string,
  fields: FieldDescribeResult[] = [],
  custom = false,
): ObjectDescribeResult {
  return {
    name,
    label: name,
    custom,
    keyPrefix: '001',
    fields,
    recordTypeInfos: [],
  };
}

/** Helper: create a global SObject describe. */
function mockGlobalSObject(
  name: string,
  overrides: Partial<GlobalSObjectDescribe> = {},
): GlobalSObjectDescribe {
  return {
    name,
    label: name,
    custom: name.endsWith('__c'),
    queryable: true,
    createable: true,
    deletable: true,
    updateable: true,
    ...overrides,
  };
}

/** Helper: create a mock AutopilotConnection. */
function mockConn(
  config: {
    describes?: Record<string, ObjectDescribeResult>;
    globalSObjects?: GlobalSObjectDescribe[];
    counts?: Record<string, number>;
  } = {},
): AutopilotConnection {
  const { describes = {}, globalSObjects = [], counts = {} } = config;

  return {
    describe: vi.fn().mockImplementation((name: string) => {
      if (describes[name]) {
        return Promise.resolve(describes[name]);
      }
      return Promise.resolve(mockDescribe(name));
    }),
    describeGlobal: vi.fn().mockImplementation(() => {
      const result: GlobalDescribeResult = { sobjects: globalSObjects };
      return Promise.resolve(result);
    }),
    query: vi.fn().mockImplementation((soql: string) => {
      const match = soql.match(/FROM (\w+)/);
      const obj = match?.[1] ?? '';
      return Promise.resolve({
        totalSize: counts[obj] ?? 0,
        done: true,
        records: [],
      });
    }),
  };
}

describe('SchemaScanner', () => {
  const scanner = new SchemaScanner(5);

  it('should auto-discover objects from describeGlobal when selectedObjects is empty', async () => {
    const source = mockConn({
      globalSObjects: [
        mockGlobalSObject('MyCustom__c'),
        mockGlobalSObject('Another__c'),
        mockGlobalSObject('Account', { custom: false }),
      ],
      describes: {
        MyCustom__c: mockDescribe('MyCustom__c', [], true),
        Another__c: mockDescribe('Another__c', [], true),
      },
    });
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('MyCustom__c'), mockGlobalSObject('Another__c')],
    });

    const result = await scanner.scan(source, target, [], false);

    // Only custom objects should be included (includeStandardObjects = false)
    expect(result.objectDescribes.has('MyCustom__c')).toBe(true);
    expect(result.objectDescribes.has('Another__c')).toBe(true);
    expect(result.objectDescribes.has('Account')).toBe(false);
    expect(source.describeGlobal).toHaveBeenCalledTimes(1);
  });

  it('should describe only selected objects and their dependencies', async () => {
    const source = mockConn({
      describes: {
        Contact: mockDescribe('Contact', [lookupField('AccountId', ['Account'], 'Account')]),
        Account: mockDescribe('Account'),
      },
    });
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('Contact'), mockGlobalSObject('Account')],
    });

    const result = await scanner.scan(source, target, ['Contact'], false);

    expect(result.objectDescribes.has('Contact')).toBe(true);
    expect(result.objectDescribes.has('Account')).toBe(true);
    expect(result.autoDiscoveredObjects).toContain('Account');
    expect(result.totalObjectsScanned).toBe(2);
  });

  it('should recursively discover dependencies (A -> B -> C)', async () => {
    const source = mockConn({
      describes: {
        A__c: mockDescribe('A__c', [lookupField('B__c', ['B__c'])], true),
        B__c: mockDescribe('B__c', [lookupField('C__c', ['C__c'])], true),
        C__c: mockDescribe('C__c', [], true),
      },
    });
    const target = mockConn({
      globalSObjects: [
        mockGlobalSObject('A__c'),
        mockGlobalSObject('B__c'),
        mockGlobalSObject('C__c'),
      ],
    });

    const result = await scanner.scan(source, target, ['A__c'], false);

    expect(result.objectDescribes.size).toBe(3);
    expect(result.objectDescribes.has('A__c')).toBe(true);
    expect(result.objectDescribes.has('B__c')).toBe(true);
    expect(result.objectDescribes.has('C__c')).toBe(true);
    expect(result.autoDiscoveredObjects).toContain('B__c');
    expect(result.autoDiscoveredObjects).toContain('C__c');
  });

  it('should detect objects missing in target', async () => {
    const source = mockConn({
      describes: {
        Account: mockDescribe('Account'),
        Contact: mockDescribe('Contact'),
      },
    });
    const target = mockConn({
      globalSObjects: [
        mockGlobalSObject('Account'),
        // Contact is missing
      ],
    });

    const result = await scanner.scan(source, target, ['Account', 'Contact'], false);

    expect(result.missingInTarget).toContain('Contact');
    expect(result.missingInTarget).not.toContain('Account');
  });

  it('should query record counts for each object', async () => {
    const source = mockConn({
      describes: {
        Account: mockDescribe('Account'),
        Contact: mockDescribe('Contact'),
      },
      counts: { Account: 5000, Contact: 12000 },
    });
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('Account'), mockGlobalSObject('Contact')],
    });

    const result = await scanner.scan(source, target, ['Account', 'Contact'], false);

    expect(result.recordCounts.get('Account')).toBe(5000);
    expect(result.recordCounts.get('Contact')).toBe(12000);
  });

  it('should respect maxConcurrent for parallel describe calls', async () => {
    const objects = Array.from({ length: 12 }, (_, i) => `Obj${i}__c`);
    const describes: Record<string, ObjectDescribeResult> = {};
    const globalSObjects: GlobalSObjectDescribe[] = [];
    for (const name of objects) {
      describes[name] = mockDescribe(name, [], true);
      globalSObjects.push(mockGlobalSObject(name));
    }

    const source = mockConn({ describes, globalSObjects });
    const target = mockConn({ globalSObjects });

    // maxConcurrent=5 means 3 batches for 12 objects
    const smallScanner = new SchemaScanner(5);
    await smallScanner.scan(source, target, objects, false);

    // All 12 objects should have been described
    expect(source.describe).toHaveBeenCalledTimes(12);
  });

  it('should handle polymorphic lookups (referenceTo with multiple targets)', async () => {
    const source = mockConn({
      describes: {
        Task: mockDescribe('Task', [lookupField('WhoId', ['Contact', 'Lead'], 'Who')]),
        Contact: mockDescribe('Contact'),
        Lead: mockDescribe('Lead'),
      },
    });
    const target = mockConn({
      globalSObjects: [
        mockGlobalSObject('Task'),
        mockGlobalSObject('Contact'),
        mockGlobalSObject('Lead'),
      ],
    });

    const result = await scanner.scan(source, target, ['Task'], false);

    expect(result.objectDescribes.has('Contact')).toBe(true);
    expect(result.objectDescribes.has('Lead')).toBe(true);
    expect(result.autoDiscoveredObjects).toContain('Contact');
    expect(result.autoDiscoveredObjects).toContain('Lead');
  });

  it('should handle self-referencing objects (Account.ParentId -> Account)', async () => {
    const source = mockConn({
      describes: {
        Account: mockDescribe('Account', [lookupField('ParentId', ['Account'], 'Parent')]),
      },
    });
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('Account')],
    });

    const result = await scanner.scan(source, target, ['Account'], false);

    // Should not loop infinitely; Account is already visited
    expect(result.objectDescribes.size).toBe(1);
    expect(result.objectDescribes.has('Account')).toBe(true);
    expect(result.autoDiscoveredObjects).toEqual([]);
  });

  it('should include standard objects when includeStandardObjects is true', async () => {
    const source = mockConn({
      globalSObjects: [
        mockGlobalSObject('Account', { custom: false }),
        mockGlobalSObject('Contact', { custom: false }),
        mockGlobalSObject('MyCustom__c'),
      ],
      describes: {
        Account: mockDescribe('Account'),
        Contact: mockDescribe('Contact'),
        MyCustom__c: mockDescribe('MyCustom__c', [], true),
      },
    });
    const target = mockConn({
      globalSObjects: [
        mockGlobalSObject('Account'),
        mockGlobalSObject('Contact'),
        mockGlobalSObject('MyCustom__c'),
      ],
    });

    const result = await scanner.scan(source, target, [], true);

    expect(result.objectDescribes.has('Account')).toBe(true);
    expect(result.objectDescribes.has('Contact')).toBe(true);
    expect(result.objectDescribes.has('MyCustom__c')).toBe(true);
  });

  it('should filter out non-queryable and non-creatable objects in auto-detect', async () => {
    const source = mockConn({
      globalSObjects: [
        mockGlobalSObject('Queryable__c', { queryable: true, createable: true }),
        mockGlobalSObject('ReadOnly__c', { queryable: true, createable: false }),
        mockGlobalSObject('NoQuery__c', { queryable: false, createable: true }),
      ],
      describes: {
        Queryable__c: mockDescribe('Queryable__c', [], true),
      },
    });
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('Queryable__c')],
    });

    const result = await scanner.scan(source, target, [], false);

    expect(result.objectDescribes.has('Queryable__c')).toBe(true);
    expect(result.objectDescribes.has('ReadOnly__c')).toBe(false);
    expect(result.objectDescribes.has('NoQuery__c')).toBe(false);
  });

  it('should handle describe failures gracefully', async () => {
    const source = mockConn({
      describes: {
        Account: mockDescribe('Account'),
      },
    });
    (source.describe as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'Restricted') {
        return Promise.reject(new Error('No access'));
      }
      return Promise.resolve(mockDescribe(name));
    });
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('Account')],
    });

    const result = await scanner.scan(source, target, ['Account', 'Restricted'], false);

    // Account should succeed, Restricted should be silently skipped
    expect(result.objectDescribes.has('Account')).toBe(true);
    expect(result.objectDescribes.has('Restricted')).toBe(false);
  });
});
