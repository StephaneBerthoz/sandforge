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

describe('objects no copy can create', () => {
  const scanner = new SchemaScanner();

  /** `describeGlobal` answering that User and friends are createable, as it does. */
  const uncopyables = ['User', 'UserRole', 'RecordType', 'Attachment'];

  function orgWithUsers() {
    return mockConn({
      globalSObjects: [
        mockGlobalSObject('Account', { custom: false }),
        ...uncopyables.map((name) => mockGlobalSObject(name, { custom: false })),
      ],
      describes: Object.fromEntries(
        ['Account', ...uncopyables].map((name) => [name, mockDescribe(name, [], false)]),
      ),
    });
  }

  it('leaves them out of a discovered object set', async () => {
    // Salesforce says User is createable — at the cost of a licence and a
    // globally unique username. A run put 39 of them in its first wave.
    const result = await scanner.scan(orgWithUsers(), orgWithUsers(), [], true);

    expect([...result.objectDescribes.keys()]).toEqual(['Account']);
  });

  it('leaves them out of an explicit selection too', async () => {
    // A saved configuration or a picker written before this existed can carry
    // one, so filtering only the discovered half would leave it reachable.
    const result = await scanner.scan(
      orgWithUsers(),
      orgWithUsers(),
      ['Account', 'User', 'RecordType'],
      true,
    );

    expect([...result.objectDescribes.keys()]).toEqual(['Account']);
  });
});

/** `conn` with a Tooling API that serves `names`, or fails with the error given. */
function withTooling(conn: AutopilotConnection, names: string[] | Error): AutopilotConnection {
  return {
    ...conn,
    tooling: {
      describeGlobal: vi.fn(async () => {
        if (names instanceof Error) throw names;
        return { sobjects: names.map((name) => ({ name })) };
      }),
    },
  };
}

describe('metadata and what the target will not create', () => {
  const scanner = new SchemaScanner();

  /** The lookups a real run walked from Order, object by object. */
  const LOOKUPS: Record<string, Array<[string, string[]]>> = {
    Order: [
      ['AccountId', ['Account']],
      ['Pricebook2Id', ['Pricebook2']],
      ['OwnerId', ['Group', 'User']],
    ],
    OrderItem: [
      ['OrderId', ['Order']],
      ['PricebookEntryId', ['PricebookEntry']],
      ['OrderActionId', ['OrderAction']],
    ],
    OrderAction: [['SourceAssetId', ['Asset']]],
    PricebookEntry: [
      ['Pricebook2Id', ['Pricebook2']],
      ['Product2Id', ['Product2']],
    ],
    Product2: [['ExternalDataSourceId', ['ExternalDataSource']]],
    ExternalDataSource: [
      ['AuthProviderId', ['AuthProvider']],
      ['LargeIconId', ['StaticResource']],
      ['NamedCredentialId', ['NamedCredential']],
    ],
    NamedCredential: [['AuthProviderId', ['AuthProvider']]],
    AuthProvider: [['RegistrationHandlerId', ['ApexClass']]],
    Account: [['PersonActionCadenceId', ['ActionCadence']]],
    ActionCadence: [['FolderId', ['Folder']]],
    Asset: [['LocationId', ['Location']]],
    Location: [['LogoId', ['ContentAsset']]],
    ContentAsset: [['ContentDocumentId', ['ContentDocument']]],
    ContentDocument: [['ParentId', ['ContentWorkspace']]],
    ContentWorkspace: [['RootContentFolderId', ['ContentFolder']]],
  };
  const OBJECTS = [
    ...Object.keys(LOOKUPS),
    'Pricebook2',
    'ApexClass',
    'StaticResource',
    'Folder',
    'ContentFolder',
  ];
  /** As the target's data API answered: these it will not create. */
  const NOT_CREATEABLE = [
    'ActionCadence',
    'ContentDocument',
    'ExternalDataSource',
    'NamedCredential',
  ];
  /** As the target's Tooling API answered, among the objects of the walk. */
  const TOOLING = [
    'ApexClass',
    'ContentAsset',
    'ExternalDataSource',
    'NamedCredential',
    'StaticResource',
  ];

  /** An org holding the objects of the walk, as a real one described them. */
  function org(): AutopilotConnection {
    return mockConn({
      globalSObjects: OBJECTS.map((name) =>
        mockGlobalSObject(name, { createable: !NOT_CREATEABLE.includes(name) }),
      ),
      describes: Object.fromEntries(
        OBJECTS.map((name) => [
          name,
          mockDescribe(
            name,
            (LOOKUPS[name] ?? []).map(([field, to]) => lookupField(field, to)),
          ),
        ]),
      ),
    });
  }

  it('does not reach a setup object from a plan rooted at Order', async () => {
    const result = await scanner.scan(
      org(),
      withTooling(org(), TOOLING),
      ['Order', 'OrderItem'],
      true,
    );

    expect([...result.objectDescribes.keys()].sort()).toEqual([
      'Account',
      'Asset',
      'Location',
      'Order',
      'OrderAction',
      'OrderItem',
      'Pricebook2',
      'PricebookEntry',
      'Product2',
    ]);
  });

  it('leaves out what the Tooling API serves, though no list of its own names it', async () => {
    const source = mockConn({
      describes: {
        Order: mockDescribe('Order', [lookupField('ConfirmationTemplate__c', ['EmailTemplate'])]),
      },
    });
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('Order'), mockGlobalSObject('EmailTemplate')],
    });

    const blind = await scanner.scan(source, target, ['Order'], true);
    const told = await scanner.scan(
      source,
      withTooling(target, ['EmailTemplate']),
      ['Order'],
      true,
    );

    expect([...blind.objectDescribes.keys()]).toEqual(['Order', 'EmailTemplate']);
    expect([...told.objectDescribes.keys()]).toEqual(['Order']);
  });

  it('leaves out what the target will not create, even asked for by name', async () => {
    const result = await scanner.scan(org(), org(), ['Order', 'ContentDocument'], true);

    const planned = [...result.objectDescribes.keys()];
    expect(planned).toContain('Order');
    for (const name of NOT_CREATEABLE) expect(planned).not.toContain(name);
  });

  it('still leaves out the rest when the Tooling API cannot be read', async () => {
    const target = withTooling(org(), new Error('API_DISABLED_FOR_ORG: API is not enabled'));

    const result = await scanner.scan(org(), target, ['Order', 'OrderItem'], true);

    const planned = [...result.objectDescribes.keys()];
    expect(planned).toContain('Product2');
    for (const name of ['ExternalDataSource', 'AuthProvider', 'Folder', 'ContentDocument']) {
      expect(planned).not.toContain(name);
    }
  });
});
