import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_SCAN_OBJECTS, SchemaScanner } from './SchemaScanner';
import { countingConnection, fakeId, largeOrg, type LargeOrgField } from '../../test/largeOrg';
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

/**
 * Helper: create a mock AutopilotConnection.
 *
 * Every object it describes holds records whose every lookup names a record
 * of what it points at — one record per object a lookup may name — so a walk
 * that follows the records reaches what the schema links: the scan takes in
 * an object only when a record it copies points at one of its records. Each
 * object gets a key prefix of its own, which the global describe gives for
 * the objects it lists and, as objects no copy picks by itself, for the rest.
 */
function mockConn(
  config: {
    describes?: Record<string, ObjectDescribeResult>;
    globalSObjects?: GlobalSObjectDescribe[];
    counts?: Record<string, number>;
  } = {},
): AutopilotConnection {
  const { describes = {}, globalSObjects = [], counts = {} } = config;
  const prefixes = new Map<string, string>();
  const prefixOf = (name: string): string => {
    if (!prefixes.has(name)) prefixes.set(name, `z${prefixes.size.toString(36).padStart(2, '0')}`);
    return prefixes.get(name) ?? 'zzz';
  };
  const describeOf = (name: string): ObjectDescribeResult => describes[name] ?? mockDescribe(name);
  const idOf = (name: string): string => `${prefixOf(name)}000000000001AAA`;
  /** The records of an object: one per object its lookups may name. */
  const rowsOf = (name: string): Record<string, unknown>[] => {
    const lookups = describeOf(name).fields.filter((f) => f.referenceTo.length > 0);
    const count = Math.max(1, ...lookups.map((f) => f.referenceTo.length));
    return Array.from({ length: count }, (_, k) => {
      const row: Record<string, unknown> = { Id: k === 0 ? idOf(name) : `${idOf(name)}${k}` };
      for (const f of lookups)
        row[f.name] = idOf(f.referenceTo[Math.min(k, f.referenceTo.length - 1)]);
      return row;
    });
  };
  for (const name of [...globalSObjects.map((s) => s.name), ...Object.keys(describes)]) {
    prefixOf(name);
  }

  return {
    describe: vi.fn().mockImplementation((name: string) => Promise.resolve(describeOf(name))),
    describeGlobal: vi.fn().mockImplementation(() => {
      const listed = new Set(globalSObjects.map((s) => s.name));
      const result: GlobalDescribeResult = {
        sobjects: [
          ...globalSObjects.map((s) => ({ ...s, keyPrefix: prefixOf(s.name) })),
          ...[...prefixes.keys()]
            .filter((name) => !listed.has(name))
            .map((name) =>
              mockGlobalSObject(name, {
                keyPrefix: prefixOf(name),
                queryable: false,
                createable: false,
              }),
            ),
        ],
      };
      return Promise.resolve(result);
    }),
    query: vi.fn().mockImplementation((soql: string) => {
      const match = soql.match(/FROM (\w+)/);
      const obj = match?.[1] ?? '';
      if (soql.startsWith('SELECT COUNT()')) {
        return Promise.resolve({ totalSize: counts[obj] ?? 0, done: true, records: [] });
      }
      const ids = /Id IN \(([^)]*)\)/
        .exec(soql)?.[1]
        .split(',')
        .map((id) => id.trim().slice(1, -1));
      const records = rowsOf(obj).filter((row) => !ids || ids.includes(String(row['Id'])));
      return Promise.resolve({ totalSize: records.length, done: true, records });
    }),
  };
}

describe('SchemaScanner', () => {
  const scanner = new SchemaScanner(5);

  it('lists the custom objects of the source from its global describe, describing none', async () => {
    const source = mockConn({
      globalSObjects: [
        mockGlobalSObject('MyCustom__c', { label: 'My custom' }),
        mockGlobalSObject('Another__c'),
        mockGlobalSObject('Account', { custom: false }),
      ],
    });
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('MyCustom__c'), mockGlobalSObject('Another__c')],
    });

    const listed = await scanner.listObjects(source, target, false);

    // Only custom objects should be included (includeStandardObjects = false)
    expect(listed).toEqual([
      { apiName: 'MyCustom__c', label: 'My custom', custom: true },
      { apiName: 'Another__c', label: 'Another__c', custom: true },
    ]);
    expect(source.describeGlobal).toHaveBeenCalledTimes(1);
    expect(source.describe).not.toHaveBeenCalled();
    expect(source.query).not.toHaveBeenCalled();
  });

  it('marks the objects the target does not have, from its global describe, and lists them all the same', async () => {
    // Offered as any other, an object never deployed to the target was
    // picked, scanned and planned, and its records refused at the write.
    const source = mockConn({
      globalSObjects: [mockGlobalSObject('Shipped__c'), mockGlobalSObject('NotDeployed__c')],
    });
    const target = mockConn({ globalSObjects: [mockGlobalSObject('Shipped__c')] });

    const listed = await scanner.listObjects(source, target, false);

    expect(listed).toEqual([
      { apiName: 'Shipped__c', label: 'Shipped__c', custom: true },
      { apiName: 'NotDeployed__c', label: 'NotDeployed__c', custom: true, missingInTarget: true },
    ]);
    expect(target.describeGlobal).toHaveBeenCalledTimes(1);
    expect(target.describe).not.toHaveBeenCalled();
  });

  it('lists what a read-only source user may read, and marks what the target user may not create', async () => {
    // Listed only when the source's user could create it, a read-only source
    // user had an empty picker; and an object the target's user could not
    // create was dropped with the platform's own, with no word.
    const source = mockConn({
      globalSObjects: [
        mockGlobalSObject('ReadOnly__c', { createable: false }),
        mockGlobalSObject('Closed__c'),
        mockGlobalSObject('Platform__c', { createable: false }),
      ],
    });
    const target = mockConn({
      globalSObjects: [
        mockGlobalSObject('ReadOnly__c'),
        mockGlobalSObject('Closed__c', { createable: false }),
        mockGlobalSObject('Platform__c', { createable: false }),
      ],
    });

    const listed = await scanner.listObjects(source, target, false);

    expect(listed).toEqual([
      { apiName: 'ReadOnly__c', label: 'ReadOnly__c', custom: true },
      { apiName: 'Closed__c', label: 'Closed__c', custom: true, notCreateableInTarget: true },
    ]);
  });

  it('refuses to scan with nothing selected, before it asks the org anything', async () => {
    // With nothing selected the scan described every object of the org and
    // counted every table, and planned a copy of all of it.
    const source = mockConn({ globalSObjects: [mockGlobalSObject('MyCustom__c')] });
    const target = mockConn({ globalSObjects: [mockGlobalSObject('MyCustom__c')] });

    await expect(scanner.scan(source, target, [], true)).rejects.toThrow(
      /Choose the objects to copy/,
    );
    expect(source.describeGlobal).not.toHaveBeenCalled();
    expect(source.describe).not.toHaveBeenCalled();
    expect(source.query).not.toHaveBeenCalled();
  });

  it('counts the records of the objects it is given, one COUNT() each, leaving out one the org will not count', async () => {
    const source = mockConn();
    (source.query as ReturnType<typeof vi.fn>).mockImplementation((soql: string) =>
      soql.includes('Locked__c')
        ? Promise.reject(new Error('sObject type Locked__c is not supported'))
        : Promise.resolve({
            totalSize: soql.includes('Account') ? 5000 : 12,
            done: true,
            records: [],
          }),
    );

    const counts = await scanner.countObjects(source, ['Account', 'Contact', 'Locked__c']);

    expect(Object.fromEntries(counts)).toEqual({ Account: 5000, Contact: 12 });
    expect(source.query).toHaveBeenCalledTimes(3);
    expect(source.describe).not.toHaveBeenCalled();
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

    const result = await scanner.scan(source, target, ['Contact'], true);

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

  it('says in the scope the currencies the target does not hold active, the one their records go in and the objects that carry one', async () => {
    /** An org answering its `CurrencyType` with `rows`, and every other query as `mockConn` does. */
    const withCurrencies = (
      conn: AutopilotConnection,
      rows: Record<string, unknown>[],
    ): AutopilotConnection => {
      const query = conn.query.bind(conn);
      return {
        ...conn,
        query: (soql: string) =>
          soql.includes('FROM CurrencyType')
            ? Promise.resolve({ totalSize: rows.length, done: true, records: rows })
            : query(soql),
      };
    };
    const source = withCurrencies(
      mockConn({
        describes: {
          Opportunity: mockDescribe('Opportunity', [
            mockField({ name: 'CurrencyIsoCode', type: 'picklist' }),
            mockField({ name: 'Amount', type: 'currency' }),
          ]),
        },
      }),
      [
        { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
        { IsoCode: 'EUR', ConversionRate: 0.92, IsActive: true, IsCorporate: false },
        { IsoCode: 'GBP', ConversionRate: 0.79, IsActive: true, IsCorporate: false },
      ],
    );
    const target = withCurrencies(
      mockConn({ globalSObjects: [mockGlobalSObject('Opportunity')] }),
      [
        { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
        { IsoCode: 'EUR', ConversionRate: 0.9, IsActive: true, IsCorporate: false },
      ],
    );

    const result = await scanner.scan(source, target, ['Opportunity'], true);

    expect(result.scope.currencies).toEqual({
      notInTarget: ['GBP'],
      writtenIn: 'USD',
      objects: ['Opportunity'],
    });
  });

  it('says nothing of currencies when no object of the plan carries one', async () => {
    const source = mockConn({ describes: { Account: mockDescribe('Account') } });
    const target = mockConn({ globalSObjects: [mockGlobalSObject('Account')] });

    const result = await scanner.scan(source, target, ['Account'], true);

    expect(result.scope.currencies).toBeUndefined();
    expect(vi.mocked(source.query).mock.calls.flat().join(' ')).not.toContain('CurrencyType');
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

    const result = await scanner.scan(source, target, ['Task'], true);

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

  it('lists standard objects too when includeStandardObjects is true', async () => {
    const source = mockConn({
      globalSObjects: [
        mockGlobalSObject('Account', { custom: false }),
        mockGlobalSObject('Contact', { custom: false }),
        mockGlobalSObject('MyCustom__c'),
      ],
    });
    const target = mockConn({
      globalSObjects: [
        mockGlobalSObject('Account'),
        mockGlobalSObject('Contact'),
        mockGlobalSObject('MyCustom__c'),
      ],
    });

    const listed = await scanner.listObjects(source, target, true);

    expect(listed.map((o) => o.apiName)).toEqual(['Account', 'Contact', 'MyCustom__c']);
    expect(listed.find((o) => o.apiName === 'Account')?.custom).toBe(false);
  });

  it('lists no object the source cannot query or create', async () => {
    const source = mockConn({
      globalSObjects: [
        mockGlobalSObject('Queryable__c', { queryable: true, createable: true }),
        mockGlobalSObject('ReadOnly__c', { queryable: true, createable: false }),
        mockGlobalSObject('NoQuery__c', { queryable: false, createable: true }),
      ],
    });
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('Queryable__c')],
    });

    const listed = await scanner.listObjects(source, target, false);

    expect(listed.map((o) => o.apiName)).toEqual(['Queryable__c']);
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

describe('the prices an opportunity’s lines use', () => {
  const STANDARD = '01s000000000001AAA';
  const BOOK = '01s000000000002AAA';
  const WIDGET = '01t000000000001AAA';
  const OPPORTUNITY = '006000000000001AAA';
  /** A price of the widget, in a book and a currency. */
  const price = (id: string, book: string, currency: string): Record<string, unknown> => ({
    Id: id,
    Pricebook2Id: book,
    Product2Id: WIDGET,
    CurrencyIsoCode: currency,
  });
  const PRICES = [
    price('01u000000000001AAA', BOOK, 'GBP'),
    price('01u000000000002AAA', STANDARD, 'GBP'),
    price('01u000000000003AAA', STANDARD, 'USD'),
  ];
  const describes: Record<string, ObjectDescribeResult> = {
    OpportunityLineItem: mockDescribe('OpportunityLineItem', [
      lookupField('OpportunityId', ['Opportunity']),
      lookupField('PricebookEntryId', ['PricebookEntry']),
    ]),
    Opportunity: mockDescribe('Opportunity'),
    PricebookEntry: mockDescribe('PricebookEntry', [
      lookupField('Pricebook2Id', ['Pricebook2']),
      lookupField('Product2Id', ['Product2']),
      mockField({ name: 'CurrencyIsoCode', type: 'picklist' }),
    ]),
    Pricebook2: mockDescribe('Pricebook2'),
    Product2: mockDescribe('Product2'),
  };
  const globalSObjects = Object.keys(describes).map((name) => mockGlobalSObject(name));
  /** A source whose one line uses the widget's GBP price of a custom book, and what it is asked. */
  function source(): { conn: AutopilotConnection; asked: string[] } {
    const conn = mockConn({ describes, globalSObjects });
    const asked: string[] = [];
    const rows = (soql: string): Record<string, unknown>[] => {
      const object = /FROM (\w+)/.exec(soql)?.[1];
      const ids = /Id IN \(([^)]*)\)/.exec(soql)?.[1];
      const named = (row: Record<string, unknown>): boolean =>
        ids === undefined || ids.includes(`'${String(row['Id'])}'`);
      if (soql === 'SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1') {
        return [{ Id: STANDARD }];
      }
      if (object === 'OpportunityLineItem') {
        return [
          {
            Id: '00k000000000001AAA',
            OpportunityId: OPPORTUNITY,
            PricebookEntryId: '01u000000000001AAA',
          },
        ];
      }
      if (object === 'Opportunity') return [{ Id: OPPORTUNITY }].filter(named);
      if (object === 'PricebookEntry' && soql.includes(`Pricebook2Id = '${STANDARD}'`)) {
        return PRICES.filter((row) => row['Pricebook2Id'] === STANDARD);
      }
      if (object === 'PricebookEntry') return PRICES.filter(named);
      if (object === 'Pricebook2') return [{ Id: STANDARD }, { Id: BOOK }].filter(named);
      if (object === 'Product2') return [{ Id: WIDGET }].filter(named);
      return [];
    };
    return {
      asked,
      conn: {
        ...conn,
        query: (soql: string) => {
          asked.push(soql);
          if (soql.startsWith('SELECT COUNT()')) {
            return Promise.resolve({ totalSize: 1, done: true, records: [] });
          }
          const records = rows(soql);
          return Promise.resolve({ totalSize: records.length, done: true, records });
        },
      },
    };
  }

  it('reads the standard price a custom one needs, in its currency, with the price', async () => {
    // Read by id alone, the lines' prices were all refused at the write,
    // STANDARD_PRICE_NOT_DEFINED, and the lines held back behind them.
    const { conn, asked } = source();

    const result = await new SchemaScanner().scan(
      conn,
      mockConn({ describes, globalSObjects }),
      ['OpportunityLineItem'],
      true,
    );

    expect(result.parentIds.get('PricebookEntry')).toEqual([
      '01u000000000001AAA',
      '01u000000000002AAA',
    ]);
    expect(result.recordCounts.get('PricebookEntry')).toBe(2);
    // The standard book is matched in the target, never written: the
    // standard price does not bring it.
    expect(result.parentIds.get('Pricebook2')).toEqual([BOOK]);
    expect(asked).toContainEqual(expect.stringContaining('CurrencyIsoCode FROM PricebookEntry'));
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

  it('leaves them out of the objects listed to choose from', async () => {
    // Salesforce says User is createable — at the cost of a licence and a
    // globally unique username. A run put 39 of them in its first wave.
    const listed = await scanner.listObjects(orgWithUsers(), orgWithUsers(), true);

    expect(listed.map((o) => o.apiName)).toEqual(['Account']);
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

describe('a selected table larger than one read takes', () => {
  /**
   * A source whose `Big__c` holds two million rows, each naming one of the
   * `Ref__c` records — the n-th row the (n / 1 000)-th — and which pages a
   * read by 2 000 rows: in the order of the ids when the read asks for it,
   * from the last id first otherwise, as a table read in no order may come.
   */
  function bigSource(): AutopilotConnection & { queries: string[] } {
    const TOTAL = 2_000_000;
    const PAGE = 2_000;
    const bigId = (n: number): string => `a01${String(n).padStart(12, '0')}AAA`;
    const refId = (n: number): string => `a02${String(n).padStart(12, '0')}AAA`;
    const rowAt = (n: number) => ({ Id: bigId(n), Parent__c: refId(Math.floor(n / 1_000)) });
    const queries: string[] = [];
    const pageOf = (ordered: boolean, from: number) => {
      const records = Array.from({ length: Math.min(PAGE, TOTAL - from) }, (_, i) =>
        rowAt(ordered ? from + i : TOTAL - 1 - (from + i)),
      );
      const next = from + records.length;
      return {
        totalSize: TOTAL,
        done: next >= TOTAL,
        records,
        ...(next < TOTAL ? { nextRecordsUrl: `/query/${ordered ? 'o' : 'u'}-${next}` } : {}),
      };
    };
    return {
      queries,
      describe: async (name: string) =>
        mockDescribe(
          name,
          name === 'Big__c'
            ? [mockField({ name: 'Id', type: 'id' }), lookupField('Parent__c', ['Ref__c'])]
            : [mockField({ name: 'Id', type: 'id' }), mockField({ name: 'Name' })],
          true,
        ),
      describeGlobal: async () => ({
        sobjects: [
          mockGlobalSObject('Big__c', { keyPrefix: 'a01' }),
          mockGlobalSObject('Ref__c', { keyPrefix: 'a02' }),
        ],
      }),
      query: async (soql: string) => {
        queries.push(soql);
        if (soql === 'SELECT COUNT() FROM Big__c') {
          return { totalSize: TOTAL, done: true, records: [] };
        }
        if (soql.startsWith('SELECT Id, Parent__c FROM Big__c')) {
          return pageOf(/ ORDER BY Id$/.test(soql), 0);
        }
        const ids = [...soql.matchAll(/'(a02\d{12}AAA)'/g)].map((m) => m[1]);
        return { totalSize: ids.length, done: true, records: ids.map((Id) => ({ Id })) };
      },
      queryMore: async (url: string) => {
        const [, kind, from] = /\/query\/(o|u)-(\d+)$/.exec(url) ?? [];
        return pageOf(kind === 'o', Number(from));
      },
    };
  }

  it('plans the first records by id, the ones the run copies, and says how many of how many', async () => {
    // Read in no order, the plan held the parents of one sample of 50 000
    // rows while the run copied the first 50 000 by id: required parents of
    // another set, and Step 4 showing 50 000 beside a count of two million.
    const source = bigSource();
    const target = mockConn({
      globalSObjects: [mockGlobalSObject('Big__c'), mockGlobalSObject('Ref__c')],
    });

    const result = await new SchemaScanner().scan(source, target, ['Big__c'], false);

    expect(result.recordCounts.get('Big__c')).toBe(50_000);
    // The parents of rows 0 to 49 999 by id: the first fifty references.
    const parents = [...(result.parentIds.get('Ref__c') ?? [])].sort();
    expect(parents).toHaveLength(50);
    expect(parents[0]).toBe(`a02${'0'.repeat(12)}AAA`);
    expect(parents[49]).toBe(`a02${String(49).padStart(12, '0')}AAA`);
    expect(result.scope.cutShort).toEqual([
      { objectApiName: 'Big__c', copied: 50_000, total: 2_000_000 },
    ]);
  });

  it('says nothing of an object read to its end', async () => {
    const { result } = await (async () => {
      const org = largeOrg();
      const scanned = await new SchemaScanner().scan(
        countingConnection(org).conn as unknown as AutopilotConnection,
        countingConnection(org).conn as unknown as AutopilotConnection,
        ['Obj004__c'],
        false,
      );
      return { result: scanned };
    })();

    expect(result.scope.cutShort).toBeUndefined();
  });
});

describe('the first look at an org of six hundred objects', () => {
  it('lists every object a run may copy in two global describes, with no call per object', async () => {
    // The panel's first scan described every object it listed and counted
    // every table: hundreds of calls on a client sandbox before anything was
    // picked.
    const org = largeOrg({ customObjects: 670 });
    const source = countingConnection(org);
    const target = countingConnection(org);

    const listed = await new SchemaScanner().listObjects(
      source.conn as unknown as AutopilotConnection,
      target.conn as unknown as AutopilotConnection,
      true,
    );

    expect(listed.length).toBeGreaterThan(670);
    expect(listed.find((o) => o.apiName === 'Obj004__c')).toEqual({
      apiName: 'Obj004__c',
      label: org.objects.get('Obj004__c')?.label,
      custom: true,
    });
    expect(source.calls.describeGlobals + target.calls.describeGlobals).toBe(2);
    expect(source.calls.describes).toEqual([]);
    expect(source.calls.queries).toEqual([]);
    expect(source.total() + target.total()).toBe(2);
  });

  it('counts only the objects picked from that list', async () => {
    const org = largeOrg({ customObjects: 670 });
    const source = countingConnection(org);

    const counts = await new SchemaScanner().countObjects(
      source.conn as unknown as AutopilotConnection,
      ['Lead', 'PostalCode__c'],
    );

    expect(Object.fromEntries(counts)).toEqual({ Lead: 30, PostalCode__c: 61_635 });
    expect(source.calls.queries).toEqual([
      'SELECT COUNT() FROM Lead',
      'SELECT COUNT() FROM PostalCode__c',
    ]);
    expect(source.calls.describes).toEqual([]);
  });
});

describe('what a selection means, on an org of six hundred objects', () => {
  /** The scan of `selected` over a fresh large org, and the calls it made of the source. */
  async function scanLarge(
    selected: string[],
    includeStandardObjects: boolean,
    options: Parameters<SchemaScanner['scan']>[4] = {},
    prepare: (org: ReturnType<typeof largeOrg>) => void = () => {},
  ) {
    const org = largeOrg();
    prepare(org);
    const source = countingConnection(org);
    const target = countingConnection(org);
    const result = await new SchemaScanner().scan(
      source.conn as unknown as AutopilotConnection,
      target.conn as unknown as AutopilotConnection,
      selected,
      includeStandardObjects,
      options,
    );
    return { org, result, source };
  }

  it('plans a bounded number of objects for two selected, not the whole org', async () => {
    // Run for real, a plan for a lead and one custom object walked every
    // lookup it met and held six hundred and one objects.
    const { result } = await scanLarge(['Lead', 'Obj004__c'], false);

    expect(result.objectDescribes.size).toBeLessThanOrEqual(DEFAULT_SCAN_OBJECTS);
    expect([...result.scope.selected].sort()).toEqual(['Lead', 'Obj004__c']);
  });

  it('counts the selected tables whole and of every other object only the records they reference', async () => {
    // The postcode table holds sixty thousand rows; the selection's records
    // name four of them, and those four are what the plan copies.
    const { org, result } = await scanLarge(['Lead', 'Obj004__c'], false);

    expect(result.recordCounts.get('Lead')).toBe(30);
    expect(result.recordCounts.get('Obj004__c')).toBe(8);
    expect(result.recordCounts.get('PostalCode__c')).toBe(4);
    expect(org.counts.PostalCode__c).toBe(61_635);
    expect([...(result.parentIds.get('PostalCode__c') ?? [])].sort()).toEqual(
      [1, 2, 3, 4].map((n) => fakeId(org, 'PostalCode__c', n)),
    );
    expect(result.scope.parents).toContainEqual({ objectApiName: 'PostalCode__c', records: 4 });
  });

  it('leaves out a standard object the selection can do without, and says which lookup stays empty', async () => {
    // One level: further along the chain an object's case is required, and
    // would bring it in.
    const { result } = await scanLarge(['Obj004__c'], false, { maxDepth: 1 });

    expect(result.objectDescribes.has('Case')).toBe(false);
    expect(result.scope.leftEmpty).toContainEqual({
      objectApiName: 'Obj004__c',
      fieldApiName: 'Case__c',
      target: 'Case',
      reason: 'standard',
    });
  });

  it('follows the account the selection references with standard objects off, by id, and says it was by default', async () => {
    // Left out as a standard object, the account of every opportunity was
    // empty: the opportunities went in without the accounts they belong to.
    const { org, result } = await scanLarge(['Opportunity'], false);

    expect(result.objectDescribes.has('Account')).toBe(true);
    // The ten opportunities name ten of the twenty accounts: those ten are read.
    expect([...(result.parentIds.get('Account') ?? [])].sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => fakeId(org, 'Account', i + 1)).sort(),
    );
    expect(result.recordCounts.get('Account')).toBe(10);
    expect(result.scope.followedByDefault).toEqual([
      { objectApiName: 'Account', referencedBy: ['Opportunity.AccountId'] },
    ]);
    expect(result.scope.standardNeeded).toEqual([]);
    expect(result.scope.leftEmpty.some((lookup) => lookup.target === 'Account')).toBe(false);
  });

  it('still leaves out the other standard objects with standard objects off', async () => {
    // A case is no account: it waits for the run to be asked to take it.
    const { result } = await scanLarge(['Obj012__c'], false, { maxDepth: 1 }, (org) => {
      for (const row of org.rows.Obj012__c) {
        row.Account__c = fakeId(org, 'Account', 1);
        row.Case__c = fakeId(org, 'Case', 1);
      }
    });

    expect(result.objectDescribes.has('Account')).toBe(true);
    expect(result.objectDescribes.has('Case')).toBe(false);
    expect(result.scope.leftEmpty).toContainEqual({
      objectApiName: 'Obj012__c',
      fieldApiName: 'Case__c',
      target: 'Case',
      reason: 'standard',
    });
  });

  /** Person accounts in the org: half the accounts, and the contact the platform wrote with each. */
  const personAccounts = (org: ReturnType<typeof largeOrg>): void => {
    const flag: LargeOrgField = {
      name: 'IsPersonAccount',
      label: 'Is person account',
      type: 'boolean',
      referenceTo: [],
      relationshipName: null,
      nillable: false,
      createable: false,
      updateable: false,
      unique: false,
      externalId: false,
      cascadeDelete: false,
      defaultValue: null,
    };
    org.objects.get('Account')?.fields.push({ ...flag });
    org.objects.get('Contact')?.fields.push({ ...flag });
    org.rows.Account.forEach((row, i) => (row.IsPersonAccount = i % 2 === 1));
    org.rows.Contact.forEach((row, i) => (row.IsPersonAccount = i < 10));
  };

  it('counts the person accounts among the accounts it reads by id, for the write gate', async () => {
    // The ten opportunities name accounts 1 to 10; the even-numbered five are
    // person accounts.
    const { result, source } = await scanLarge(['Opportunity'], false, {}, personAccounts);

    expect(result.personAccounts.get('Account')).toBe(5);
    expect(result.personAccounts.has('Contact')).toBe(false);
    expect(source.calls.queries.filter((q) => q.includes('IsPersonAccount = true'))).toHaveLength(
      1,
    );
  });

  it('counts the person contacts of a selected contact table in one count', async () => {
    const { result } = await scanLarge(['Contact'], false, {}, personAccounts);

    expect(result.personAccounts.get('Contact')).toBe(10);
  });

  it('counts no person account in an org without them', async () => {
    const { result, source } = await scanLarge(['Opportunity'], false);

    expect(result.personAccounts.size).toBe(0);
    expect(source.calls.queries.some((q) => q.includes('IsPersonAccount'))).toBe(false);
  });

  it('says nothing was followed by default when the run takes standard objects', async () => {
    const { result } = await scanLarge(['Opportunity'], true);

    expect(result.objectDescribes.has('Account')).toBe(true);
    expect(result.scope.followedByDefault).toBeUndefined();
  });

  it('takes a standard object asked for, reading only the records the selection names', async () => {
    const { result } = await scanLarge(['Obj004__c'], true, {}, (org) => {
      org.counts.Case = 15_000;
    });

    expect(result.objectDescribes.has('Case')).toBe(true);
    // Four cases are named by the eight rows; the org's other cases are not copied.
    expect(result.recordCounts.get('Case')).toBe(4);
  });

  it('takes a standard object a record cannot be written without, and says why', async () => {
    // Obj008__c's case is required: left out, every row would be refused.
    const { result } = await scanLarge(['Obj008__c'], false);

    expect(result.objectDescribes.has('Case')).toBe(true);
    expect(result.scope.standardNeeded).toContainEqual({
      objectApiName: 'Case',
      neededBy: 'Obj008__c.Case__c',
    });
  });

  /** Rows along the chain: Obj004's name a record of Obj005 and of Obj029, Obj005's one of Obj006. */
  const chain = (org: ReturnType<typeof largeOrg>): void => {
    for (const row of org.rows.Obj004__c) {
      row.Next__c = fakeId(org, 'Obj005__c', 1);
      row.Other__c = fakeId(org, 'Obj029__c', 1);
    }
    org.rows.Obj005__c = [
      { Id: fakeId(org, 'Obj005__c', 1), Next__c: fakeId(org, 'Obj006__c', 1) },
    ];
    org.rows.Obj006__c = [{ Id: fakeId(org, 'Obj006__c', 1) }];
    org.rows.Obj029__c = [{ Id: fakeId(org, 'Obj029__c', 1) }];
  };

  it('follows lookups no further than the depth, and says what lies past it', async () => {
    const { result } = await scanLarge(['Obj004__c'], false, { maxDepth: 1 }, chain);

    expect(result.objectDescribes.has('Obj005__c')).toBe(true);
    expect(result.objectDescribes.has('Obj006__c')).toBe(false);
    expect(result.scope.leftEmpty).toContainEqual({
      objectApiName: 'Obj005__c',
      fieldApiName: 'Next__c',
      target: 'Obj006__c',
      reason: 'depth',
    });
    expect(result.scope.maxDepth).toBe(1);
  });

  it('holds no more objects than the bound, and names the lookups the bound left empty', async () => {
    const { result } = await scanLarge(['Obj004__c'], false, { maxObjects: 3 }, chain);

    expect(result.objectDescribes.size).toBe(3);
    expect(result.scope.leftEmpty.some((lookup) => lookup.reason === 'objects')).toBe(true);
  });

  it('raises the object bound for a parent a record cannot be written without', async () => {
    const { result } = await scanLarge(['Obj008__c'], true, { maxObjects: 1 });

    // The bound of one is the selected object; its required case raises it.
    expect([...result.objectDescribes.keys()].sort()).toEqual(['Case', 'Obj008__c']);
  });

  it('takes in only the objects the records name, however many a lookup may point at', async () => {
    // A lookup of a hundred possible objects filled a plan's bound with empty
    // tables: an object comes in now only when a record names one of its own.
    const { result } = await scanLarge(['Obj004__c'], true);

    expect([...result.objectDescribes.keys()].sort()).toEqual([
      'Account',
      'Case',
      'Contact',
      'Obj004__c',
      'PostalCode__c',
    ]);
    expect([...result.recordCounts.values()].every((count) => count > 0)).toBe(true);
  });

  it('describes only the planned objects and reads parents by id, a few calls per object', async () => {
    const { result, source } = await scanLarge(['Lead', 'Obj004__c'], true);

    const planned = result.objectDescribes.size;
    expect(source.calls.describes).toHaveLength(planned);
    // A count of a selected object with no lookup to follow, a read of the
    // lookups of the other, then one read by id per parent object per level
    // of ids: never a count per object of the org.
    expect(source.calls.queries.filter((q) => q.startsWith('SELECT COUNT()'))).toEqual([
      'SELECT COUNT() FROM Lead',
    ]);
    expect(source.calls.queries.length).toBeLessThanOrEqual(2 + planned);
  });

  it('tells a polymorphic lookup which object an id belongs to by its key prefix', async () => {
    const { org, result } = await scanLarge(['Task'], true, {}, (org) => {
      org.rows.Task = [
        { Id: fakeId(org, 'Task', 1), WhatId: fakeId(org, 'Case', 2), WhoId: null },
        { Id: fakeId(org, 'Task', 2), WhatId: fakeId(org, 'Account', 3), WhoId: null },
      ];
    });

    expect(result.parentIds.get('Case')).toEqual([fakeId(org, 'Case', 2)]);
    // The task's account, and the case's, read a level further.
    expect([...(result.parentIds.get('Account') ?? [])].sort()).toEqual([
      fakeId(org, 'Account', 2),
      fakeId(org, 'Account', 3),
    ]);
    // No record names an opportunity: none is in the plan.
    expect(result.objectDescribes.has('Opportunity')).toBe(false);
  });
});
