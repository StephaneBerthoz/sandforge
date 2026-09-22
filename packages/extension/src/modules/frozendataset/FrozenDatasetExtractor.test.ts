import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import type { ScopableField } from '../forge/ScopedSoqlBuilder.js';
import {
  DEFAULT_RECORD_TYPES_SOQL,
  FrozenDatasetExtractor,
  FrozenExtractionError,
  RT_MAP_FILE_NAME,
  type FrozenExtractionOptions,
} from './FrozenDatasetExtractor.js';
import { InsideRepoPathError, SasPathGuard } from './SasPathGuard.js';
import { to18 } from './salesforceId.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-extract-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeNode(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 0,
    fieldCount: 0,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

const ACCOUNT_A = to18('001A000000aaaaA');
const ACCOUNT_B = to18('001A000000bbbbB');
const CONTACT_1 = to18('003A000000ccccC');
const CONTACT_2 = to18('003A000000ddddD');
const OWNER_OUT_OF_SCOPE = to18('005A000000eeeeE');
const RT_INDIVIDUAL = to18('012A000000ffffF');

const graph: ForgeGraph = {
  nodes: [makeNode('Account', 0), makeNode('Contact', 1), makeNode('Orphan__c', 2)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 0,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const fieldsByObject: Record<string, ScopableField[]> = {
  Account: [
    { name: 'Id', type: 'id', referenceTo: [] },
    { name: 'Name', type: 'string', referenceTo: [] },
    { name: 'RecordTypeId', type: 'reference', referenceTo: ['RecordType'] },
    { name: 'OwnerId', type: 'reference', referenceTo: ['User'] },
    { name: 'CreatedDate', type: 'datetime', referenceTo: [] },
  ],
  Contact: [
    { name: 'Id', type: 'id', referenceTo: [] },
    { name: 'LastName', type: 'string', referenceTo: [] },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
    { name: 'CreatedDate', type: 'datetime', referenceTo: [] },
  ],
  Orphan__c: [{ name: 'Id', type: 'id', referenceTo: [] }],
};

const AS_OF = '2026-08-01T00:00:00Z';

function buildDeps(captured: string[]) {
  return {
    describeFields: async (objectApiName: string) => fieldsByObject[objectApiName] ?? [],
    query: async (soql: string) => {
      captured.push(soql);
      if (soql.includes('FROM Account')) {
        return [
          { Id: ACCOUNT_B, Name: 'Beta', RecordTypeId: RT_INDIVIDUAL, OwnerId: OWNER_OUT_OF_SCOPE },
          {
            Id: ACCOUNT_A,
            Name: 'Alpha',
            RecordTypeId: RT_INDIVIDUAL,
            OwnerId: OWNER_OUT_OF_SCOPE,
          },
        ];
      }
      if (soql.includes('FROM Contact')) {
        return [
          { Id: CONTACT_1, LastName: 'Dupont', AccountId: ACCOUNT_A },
          { Id: CONTACT_2, LastName: 'Martin', AccountId: ACCOUNT_B },
        ];
      }
      if (soql.includes('FROM RecordType')) {
        return [
          {
            Id: RT_INDIVIDUAL,
            SobjectType: 'Account',
            DeveloperName: 'Individual',
            Name: 'Particulier',
          },
        ];
      }
      return [];
    },
  };
}

function makeOptions(sasDir: string, captured: string[]): FrozenExtractionOptions {
  void captured;
  return {
    graph,
    rootObject: 'Account',
    rootRecordIds: [ACCOUNT_A, ACCOUNT_B],
    asOf: AS_OF,
    sasDir,
    guard: new SasPathGuard(path.join(sasDir, 'fake-repo')),
  };
}

describe('FrozenDatasetExtractor', () => {
  it('scopes every query to the sas-injected root IDs — no hard-coded IDs in code', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    await extractor.extract(makeOptions(dir, captured));

    const accountSoql = captured.find((q) => q.includes('FROM Account'));
    expect(accountSoql).toBeDefined();
    // Root scope comes from the injected ID list (self-cached branch).
    expect(accountSoql).toContain(`'${ACCOUNT_A}'`);
    expect(accountSoql).toContain(`'${ACCOUNT_B}'`);
    expect(accountSoql).toContain('Id IN (');
  });

  it('freezes a CreatedDate bound on every node query', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    await extractor.extract(makeOptions(dir, captured));

    const dataQueries = captured.filter((q) => !q.includes('FROM RecordType'));
    expect(dataQueries.length).toBeGreaterThanOrEqual(2);
    for (const soql of dataQueries) {
      expect(soql).toContain(`CreatedDate <= ${AS_OF}`);
    }
  });

  it('scopes children via parent FK (Contact via AccountId)', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    await extractor.extract(makeOptions(dir, captured));

    const contactSoql = captured.find((q) => q.includes('FROM Contact'));
    expect(contactSoql).toContain('AccountId IN (');
    // Unreachable node: never queried (unscoped).
    expect(captured.some((q) => q.includes('FROM Orphan__c'))).toBe(false);
  });

  it('assigns stable referenceIds in source-ID-sorted order', async () => {
    const dir = makeTmpDir();
    const extractor = new FrozenDatasetExtractor(buildDeps([]));
    const first = await extractor.extract(makeOptions(dir, []));
    const second = await extractor.extract(makeOptions(dir, []));

    const accountIds = (ds: typeof first) =>
      ds.objects.find((o) => o.objectApiName === 'Account')?.records.map((r) => r.referenceId);
    expect(accountIds(first)).toEqual(accountIds(second));
    // ACCOUNT_A sorts before ACCOUNT_B → gets -000001.
    const accountA = first.objects
      .find((o) => o.objectApiName === 'Account')
      ?.records.find((r) => r.sourceId === ACCOUNT_A);
    expect(accountA?.referenceId).toBe('Account-000001');
    expect(accountA?.fields.Name).toBe('Alpha');
  });

  it('writes rt-map.json into the sas (Id → SobjectType/DeveloperName/Name)', async () => {
    const dir = makeTmpDir();
    const extractor = new FrozenDatasetExtractor(buildDeps([]));
    const result = await extractor.extract(makeOptions(dir, []));

    const rtMapPath = path.join(dir, RT_MAP_FILE_NAME);
    expect(fs.existsSync(rtMapPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(rtMapPath, 'utf8'));
    expect(written).toEqual([
      {
        id: RT_INDIVIDUAL,
        sobjectType: 'Account',
        developerName: 'Individual',
        name: 'Particulier',
      },
    ]);
    expect(result.recordTypeMap).toEqual(written);
    expect(result.asOf).toBe(AS_OF);
  });

  it('renders {{TOKEN}} placeholders of the RecordType template from sas tokens', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    const options = makeOptions(dir, captured);
    options.recordTypesSoqlTemplate =
      'SELECT Id, SobjectType, DeveloperName, Name FROM RecordType WHERE CreatedDate <= {{AS_OF}}';
    options.tokens = { AS_OF };
    await extractor.extract(options);

    const rtSoql = captured.find((q) => q.includes('FROM RecordType'));
    expect(rtSoql).toContain(`CreatedDate <= ${AS_OF}`);
    expect(rtSoql).not.toContain('{{');
  });

  it('uses the default RecordType template otherwise', async () => {
    const dir = makeTmpDir();
    const captured: string[] = [];
    const extractor = new FrozenDatasetExtractor(buildDeps(captured));
    await extractor.extract(makeOptions(dir, captured));
    expect(captured.find((q) => q.includes('FROM RecordType'))).toBe(DEFAULT_RECORD_TYPES_SOQL);
  });

  it('refuses a sas directory inside the repository', async () => {
    const repoGuard = new SasPathGuard();
    const insideRepo = path.join(repoGuard.repoRoot, 'frozen-sas');
    const extractor = new FrozenDatasetExtractor(buildDeps([]));
    await expect(
      extractor.extract({ ...makeOptions('', []), sasDir: insideRepo, guard: repoGuard }),
    ).rejects.toThrow(InsideRepoPathError);
    expect(fs.existsSync(insideRepo)).toBe(false);
  });

  it('reads every query of a selection too large for one, keeping each record once', async () => {
    const dir = makeTmpDir();
    const accountIds = Array.from({ length: 1300 }, (_, i) =>
      to18(`001A${String(i).padStart(11, '0')}`),
    );
    const sharedContact = to18('003A000000zzzzZ');
    const captured: string[] = [];
    const quotedIds = (soql: string): string[] =>
      [...soql.matchAll(/'([A-Za-z0-9]{18})'/g)].map((m) => m[1]);
    const extractor = new FrozenDatasetExtractor({
      describeFields: async (objectApiName: string) => fieldsByObject[objectApiName] ?? [],
      query: async (soql: string) => {
        captured.push(soql);
        if (soql.includes('FROM Account')) {
          return quotedIds(soql).map((id) => ({ Id: id, Name: id }));
        }
        if (soql.includes('FROM Contact')) {
          // One Contact per Account in the statement, plus one row every
          // statement returns again.
          return [
            ...quotedIds(soql).map((accountId) => ({
              Id: `003${accountId.slice(3)}`,
              LastName: 'Dupont',
              AccountId: accountId,
            })),
            { Id: sharedContact, LastName: 'Martin', AccountId: accountIds[0] },
          ];
        }
        return [];
      },
    });

    const result = await extractor.extract({
      ...makeOptions(dir, captured),
      rootRecordIds: accountIds,
    });

    const accountQueries = captured.filter((q) => q.includes('FROM Account'));
    const contactQueries = captured.filter((q) => q.includes('FROM Contact'));
    expect(accountQueries.length).toBeGreaterThan(1);
    expect(contactQueries.length).toBeGreaterThan(1);
    expect(accountQueries.flatMap(quotedIds).sort()).toEqual([...accountIds].sort());
    expect(contactQueries.flatMap(quotedIds).sort()).toEqual([...accountIds].sort());

    const recordsOf = (objectApiName: string) =>
      result.objects.find((o) => o.objectApiName === objectApiName)?.records ?? [];
    expect(recordsOf('Account')).toHaveLength(1300);
    const contactIds = recordsOf('Contact').map((r) => r.sourceId);
    expect(contactIds).toHaveLength(1301);
    expect(new Set(contactIds).size).toBe(1301);
  });

  it('rejects a malformed asOf bound and an empty root selection', async () => {
    const dir = makeTmpDir();
    const extractor = new FrozenDatasetExtractor(buildDeps([]));
    const options = makeOptions(dir, []);
    await expect(extractor.extract({ ...options, asOf: '2026-08-01' })).rejects.toThrow(
      FrozenExtractionError,
    );
    await expect(extractor.extract({ ...options, rootRecordIds: [] })).rejects.toThrow(
      /empty selection/,
    );
  });
});

describe('FrozenDatasetExtractor — an object with no CreatedDate', () => {
  it('reads it without the bound instead of failing the whole extraction', async () => {
    // Not every object carries CreatedDate. `DashboardComponent` is one, and
    // Salesforce answers "No such column 'CreatedDate'" — which took a real
    // extraction down over a single node of its graph.
    const dir = makeTmpDir();
    const queries: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        queries.push(soql);
        return [{ Id: ACCOUNT_A }];
      },
      describeFields: async (objectApiName) =>
        objectApiName === 'NoDates'
          ? [
              { name: 'Id', type: 'id', referenceTo: [] },
              // The lookup that puts it in scope: without one the builder
              // finds no path to the root and never queries the object.
              { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
            ]
          : [
              { name: 'Id', type: 'id', referenceTo: [] },
              { name: 'CreatedDate', type: 'datetime', referenceTo: [] },
            ],
    });

    const dataset = await extractor.extract({
      ...makeOptions(dir, []),
      graph: {
        nodes: [makeNode('Account', 0), makeNode('NoDates', 1)],
        edges: [
          {
            sourceObject: 'Account',
            targetObject: 'NoDates',
            relationshipName: 'NoDatesList',
            type: 'lookup',
          },
        ],
        totalRecords: 2,
        estimatedSizeMB: 0,
        estimatedDurationSeconds: 0,
      } as never,
    });

    const unbounded = queries.filter((q) => !q.includes('CreatedDate <='));
    expect(queries.some((q) => q.includes('CreatedDate <='))).toBe(true);
    expect(unbounded.some((q) => q.includes('FROM NoDates'))).toBe(true);
    // Named rather than left to look like the rest: a caller that has to
    // state what its dataset is frozen to needs to know what is not.
    expect(dataset.unboundedObjects).toContain('NoDates');
  });
});

describe('FrozenDatasetExtractor — prices', () => {
  const PRODUCT_A = to18('01tA00000000prA');
  const PRODUCT_B = to18('01tA00000000prB');
  const STANDARD = to18('01sA00000000STD');
  const CUSTOM = to18('01sA00000000CUS');
  const CUSTOM_LIVE = to18('01uA00000000cu1');
  const CUSTOM_RETIRED = to18('01uA00000000cu2');
  const STANDARD_A = to18('01uA00000000st1');

  it('reads the standard prices of the products it prices, and the standard book', async () => {
    // Scope reaches a line item's entry in its custom book, never the
    // product's standard entry, and the target takes no custom price without
    // one: loaded for real, every custom price was refused.
    const dir = makeTmpDir();
    const queries: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        queries.push(soql);
        if (soql.includes('IsStandard = true')) return [{ Id: STANDARD }];
        if (soql.includes('FROM Pricebook2')) {
          return [{ attributes: { type: 'Pricebook2' }, Id: STANDARD, Name: 'Standard' }];
        }
        if (soql.includes('FROM PricebookEntry') && soql.includes(`Pricebook2Id = '${STANDARD}'`)) {
          return [
            {
              attributes: { type: 'PricebookEntry' },
              Id: STANDARD_A,
              Pricebook2Id: STANDARD,
              Product2Id: PRODUCT_A,
              IsActive: true,
            },
          ];
        }
        if (soql.includes('FROM PricebookEntry')) {
          return [
            { Id: CUSTOM_LIVE, Pricebook2Id: CUSTOM, Product2Id: PRODUCT_A, IsActive: true },
            // A retired price for the same product in the same book: the
            // target holds one per pair and refuses the second.
            { Id: CUSTOM_RETIRED, Pricebook2Id: CUSTOM, Product2Id: PRODUCT_A, IsActive: false },
          ];
        }
        if (soql.includes('FROM Product2')) {
          return [
            { attributes: { type: 'Product2' }, Id: PRODUCT_A, Name: 'A' },
            { Id: PRODUCT_B, Name: 'B' },
          ];
        }
        return [];
      },
      describeFields: async (objectApiName) => {
        const common = [
          { name: 'Id', type: 'id', referenceTo: [] },
          { name: 'CreatedDate', type: 'datetime', referenceTo: [] },
        ];
        if (objectApiName === 'PricebookEntry') {
          return [
            ...common,
            {
              name: 'Pricebook2Id',
              type: 'reference',
              referenceTo: ['Pricebook2'],
              nillable: false,
            },
            { name: 'Product2Id', type: 'reference', referenceTo: ['Product2'], nillable: false },
            { name: 'IsActive', type: 'boolean', referenceTo: [] },
          ];
        }
        return [...common, { name: 'Name', type: 'string', referenceTo: [] }];
      },
    });

    const dataset = await extractor.extract({
      ...makeOptions(dir, []),
      rootObject: 'Product2',
      rootRecordIds: [PRODUCT_A, PRODUCT_B],
      graph: {
        nodes: [makeNode('Product2', 0), makeNode('PricebookEntry', 1)],
        edges: [
          {
            sourceObject: 'Product2',
            targetObject: 'PricebookEntry',
            relationshipName: 'PricebookEntries',
            type: 'lookup',
          },
        ],
        totalRecords: 0,
        estimatedSizeMB: 0,
        estimatedDurationSeconds: 0,
      } as never,
    });

    expect(dataset.standardPricebookSourceId).toBe(STANDARD);
    const entries = dataset.objects.find((o) => o.objectApiName === 'PricebookEntry')?.records;
    expect(entries?.map((r) => r.sourceId).sort()).toEqual([CUSTOM_LIVE, STANDARD_A].sort());
    expect(dataset.objects.find((o) => o.objectApiName === 'Pricebook2')?.records[0].sourceId).toBe(
      STANDARD,
    );
    // Asked for the products the custom prices price — and only those.
    const standardRead = queries.find((q) => q.includes(`Pricebook2Id = '${STANDARD}'`));
    expect(standardRead).toContain(`Product2Id IN ('${PRODUCT_A}')`);
    expect(standardRead).toContain('CreatedDate <=');
    // jsforce's envelope is not a field.
    for (const object of dataset.objects) {
      for (const record of object.records) expect(record.fields).not.toHaveProperty('attributes');
    }
  });

  it('names the fields that hold a file', async () => {
    const dir = makeTmpDir();
    const extractor = new FrozenDatasetExtractor({
      query: async () => [],
      describeFields: async (objectApiName) =>
        objectApiName === 'Account'
          ? [
              { name: 'Id', type: 'id', referenceTo: [] },
              { name: 'Logo__c', type: 'base64', referenceTo: [] },
            ]
          : [{ name: 'Id', type: 'id', referenceTo: [] }],
    });

    const dataset = await extractor.extract(makeOptions(dir, []));

    expect(dataset.fileFields).toEqual({ Account: ['Logo__c'] });
  });
});

describe('FrozenDatasetExtractor — required parents scope reached late', () => {
  const ACCOUNT = to18('001A00000000acc');
  const ORDER = to18('801A00000000ord');
  const ITEM = to18('802A00000000itm');
  const PRICE = to18('01uA00000000prc');
  const BOOK = to18('01sA00000000bok');

  it('fetches them by id, and theirs, until none is missing', async () => {
    // Run for real: an order's items named prices of a book the dataset had
    // not read, and two activated orders came back with no product at all.
    const dir = makeTmpDir();
    const queries: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        queries.push(soql);
        if (soql.includes('FROM Account')) return [{ Id: ACCOUNT }];
        if (soql.includes('FROM Order ')) return [{ Id: ORDER, AccountId: ACCOUNT }];
        if (soql.includes('FROM OrderItem')) {
          return [{ Id: ITEM, OrderId: ORDER, PricebookEntryId: PRICE }];
        }
        if (soql.includes('FROM PricebookEntry') && soql.includes(`Id IN ('${PRICE}')`)) {
          return [{ Id: PRICE, Pricebook2Id: BOOK }];
        }
        if (soql.includes('FROM Pricebook2') && soql.includes(`Id IN ('${BOOK}')`)) {
          return [{ Id: BOOK }];
        }
        return [];
      },
      describeFields: async (objectApiName) => {
        const id = { name: 'Id', type: 'id', referenceTo: [] };
        const ref = (name: string, to: string, required = true) => ({
          name,
          type: 'reference',
          referenceTo: [to],
          nillable: !required,
        });
        switch (objectApiName) {
          case 'Order':
            return [id, ref('AccountId', 'Account')];
          case 'OrderItem':
            return [id, ref('OrderId', 'Order'), ref('PricebookEntryId', 'PricebookEntry')];
          case 'PricebookEntry':
            return [id, ref('Pricebook2Id', 'Pricebook2')];
          default:
            return [id];
        }
      },
    });

    const dataset = await extractor.extract({
      ...makeOptions(dir, []),
      rootObject: 'Account',
      rootRecordIds: [ACCOUNT],
      graph: {
        // Price book and entries sit at a level read before the items that
        // need them: scope reaches them too late.
        nodes: [
          makeNode('Account', 0),
          makeNode('Pricebook2', 1),
          makeNode('PricebookEntry', 1),
          makeNode('Order', 1),
          makeNode('OrderItem', 2),
        ],
        edges: [
          {
            sourceObject: 'Account',
            targetObject: 'Order',
            relationshipName: 'Orders',
            type: 'lookup',
          },
          {
            sourceObject: 'Order',
            targetObject: 'OrderItem',
            relationshipName: 'OrderItems',
            type: 'lookup',
          },
        ],
        totalRecords: 0,
        estimatedSizeMB: 0,
        estimatedDurationSeconds: 0,
      } as never,
    });

    const ids = (name: string) =>
      dataset.objects.find((o) => o.objectApiName === name)?.records.map((r) => r.sourceId);
    expect(ids('OrderItem')).toEqual([ITEM]);
    expect(ids('PricebookEntry')).toEqual([PRICE]);
    expect(ids('Pricebook2')).toEqual([BOOK]);
  });

  it('leaves an optional lookup to what scope reached', async () => {
    const dir = makeTmpDir();
    const queries: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        queries.push(soql);
        if (soql.includes('FROM Account'))
          return [{ Id: ACCOUNT, Parent__c: to18('001A0000000prnt') }];
        return [];
      },
      describeFields: async () => [
        { name: 'Id', type: 'id', referenceTo: [] },
        { name: 'Parent__c', type: 'reference', referenceTo: ['Account'], nillable: true },
      ],
    });

    await extractor.extract({ ...makeOptions(dir, []), rootRecordIds: [ACCOUNT] });

    expect(queries.filter((q) => q.includes('FROM Account'))).toHaveLength(1);
  });
});

describe('FrozenDatasetExtractor — the dossier edge and the catalog', () => {
  it('holds a required lookup to the dossier, and leaves one into the catalog open', async () => {
    const dir = makeTmpDir();
    const ACCOUNT = to18('001A00000000acc');
    const queries: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        queries.push(soql);
        return soql.includes('FROM Account') ? [{ Id: ACCOUNT }] : [];
      },
      describeFields: async (objectApiName) =>
        objectApiName === 'Account'
          ? [{ name: 'Id', type: 'id', referenceTo: [] }]
          : [
              { name: 'Id', type: 'id', referenceTo: [] },
              { name: 'AccountId', type: 'reference', referenceTo: ['Account'], nillable: false },
              {
                name: 'PricebookEntryId',
                type: 'reference',
                referenceTo: ['PricebookEntry'],
                nillable: false,
              },
            ],
    });

    await extractor.extract({
      ...makeOptions(dir, []),
      rootRecordIds: [ACCOUNT],
      graph: {
        nodes: [makeNode('Account', 0), makeNode('PricebookEntry', 0), makeNode('Line__c', 1)],
        edges: [
          {
            sourceObject: 'Account',
            targetObject: 'Line__c',
            relationshipName: 'Lines',
            type: 'lookup',
          },
        ],
        totalRecords: 0,
        estimatedSizeMB: 0,
        estimatedDurationSeconds: 0,
      } as never,
    });

    const lineRead = queries.find((q) => q.includes('FROM Line__c'));
    expect(lineRead).toContain('AND (AccountId IN (');
    expect(lineRead).not.toContain('PricebookEntryId IN');
  });
});
