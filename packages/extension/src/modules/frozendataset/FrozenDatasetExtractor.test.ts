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
import { DeterministicPseudonymizer } from './DeterministicPseudonymizer.js';
import { FrozenDatasetAnonymizer } from './FrozenDatasetAnonymizer.js';
import { parsePseudonymRules } from './rulesFile.js';
import { to18 } from './salesforceId.js';
import type { ExtractedDataset } from './types.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

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
        if (
          soql.includes('FROM PricebookEntry') &&
          soql.includes(`Pricebook2Id IN ('${STANDARD}')`)
        ) {
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
    const standardRead = queries.find((q) => q.includes(`Pricebook2Id IN ('${STANDARD}')`));
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

describe('FrozenDatasetExtractor — a required lookup at an object it never reads', () => {
  it('keeps the contacts of a root account whoever owns or created them', async () => {
    // `OwnerId` and `CreatedById` are required lookups at a User, which the
    // extraction never reads. Held to the users the root account named, a
    // contact of anyone else was left out of the dataset.
    const dir = makeTmpDir();
    const FIRST_USER = to18('005A00000000us1');
    const SECOND_USER = to18('005A00000000us2');
    const tables: Record<string, FakeRow[]> = {
      Account: [{ Id: ACCOUNT_A, OwnerId: FIRST_USER, CreatedById: FIRST_USER }],
      Contact: [
        { Id: CONTACT_1, AccountId: ACCOUNT_A, OwnerId: FIRST_USER, CreatedById: FIRST_USER },
        { Id: CONTACT_2, AccountId: ACCOUNT_A, OwnerId: SECOND_USER, CreatedById: SECOND_USER },
      ],
    };
    const user = (name: string): ScopableField => ({
      name,
      type: 'reference',
      referenceTo: ['User'],
      nillable: false,
    });
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => (soql.includes('FROM RecordType') ? [] : selectRows(tables, soql)),
      describeFields: async (objectApiName) => [
        { name: 'Id', type: 'id', referenceTo: [] },
        ...(objectApiName === 'Contact'
          ? [{ name: 'AccountId', type: 'reference', referenceTo: ['Account'] }]
          : []),
        user('OwnerId'),
        user('CreatedById'),
      ],
    });

    const dataset = await extractor.extract({
      ...makeOptions(dir, []),
      rootRecordIds: [ACCOUNT_A],
    });

    const contacts = dataset.objects.find((o) => o.objectApiName === 'Contact')?.records;
    expect(contacts?.map((r) => r.sourceId)).toEqual([CONTACT_1, CONTACT_2]);
  });
});

const id: ScopableField = { name: 'Id', type: 'id', referenceTo: [] };

function lookup(name: string, to: string[], nillable = true): ScopableField {
  return { name, type: 'reference', referenceTo: to, nillable };
}

function edge(sourceObject: string, targetObject: string, relationshipName: string) {
  return { sourceObject, targetObject, relationshipName, type: 'lookup' as const };
}

function graphOf(nodes: ForgeGraphNode[], edges: ForgeGraph['edges']): ForgeGraph {
  return { nodes, edges, totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 };
}

/** An extractor reading a source org in miniature (`selectRows`). */
function extractorOver(
  tables: Record<string, FakeRow[]>,
  fields: Record<string, ScopableField[]>,
): FrozenDatasetExtractor {
  return new FrozenDatasetExtractor({
    query: async (soql) => (soql.includes('FROM RecordType') ? [] : selectRows(tables, soql)),
    describeFields: async (objectApiName) => fields[objectApiName] ?? [id],
  });
}

function sourceIdsOf(dataset: ExtractedDataset, objectApiName: string): string[] {
  return (
    dataset.objects
      .find((o) => o.objectApiName === objectApiName)
      ?.records.map((r) => r.sourceId) ?? []
  );
}

describe('FrozenDatasetExtractor — an object reached two ways', () => {
  const OPPORTUNITY = to18('006A00000000opp');
  const ACCOUNT = to18('001A00000000acc');
  const OTHER_ACCOUNT = to18('001A00000000oth');
  const NAMED_CONTACT = to18('003A00000000nam');
  const SIBLING_CONTACT = to18('003A00000000sib');
  const STRANGER_CONTACT = to18('003A00000000str');
  const FEED_ITEM = to18('0D5A00000000fee');
  const FIRST_ORDER = to18('801A00000000or1');
  const SECOND_ORDER = to18('801A00000000or2');
  const OTHER_ORDER = to18('801A00000000or3');

  it('reads the contacts of the account as well as the one the opportunity names', async () => {
    // The opportunity's contact lookup put one contact in scope before
    // Contact was read, and read by that id alone, the account's other
    // contacts were never asked for.
    const dir = makeTmpDir();
    const extractor = extractorOver(
      {
        Opportunity: [{ Id: OPPORTUNITY, AccountId: ACCOUNT, ContactId: NAMED_CONTACT }],
        Account: [{ Id: ACCOUNT }, { Id: OTHER_ACCOUNT }],
        Contact: [
          { Id: NAMED_CONTACT, AccountId: ACCOUNT },
          { Id: SIBLING_CONTACT, AccountId: ACCOUNT },
          { Id: STRANGER_CONTACT, AccountId: OTHER_ACCOUNT },
        ],
      },
      {
        Opportunity: [id, lookup('AccountId', ['Account']), lookup('ContactId', ['Contact'])],
        Contact: [id, lookup('AccountId', ['Account'])],
      },
    );

    const dataset = await extractor.extract({
      ...makeOptions(dir, []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [makeNode('Opportunity', 0), makeNode('Account', 1), makeNode('Contact', 2)],
        [
          edge('Account', 'Opportunity', 'Opportunities'),
          edge('Contact', 'Opportunity', 'Opportunities'),
          edge('Account', 'Contact', 'Contacts'),
        ],
      ),
    });

    expect(sourceIdsOf(dataset, 'Contact')).toEqual([NAMED_CONTACT, SIBLING_CONTACT].sort());
    expect(sourceIdsOf(dataset, 'Account')).toEqual([ACCOUNT]);
  });

  it('reads the orders of the opportunity after a feed item named it as an order', async () => {
    // A feed item's parent can be nearly any object, and the id it holds was
    // put in scope under each of them. Run for real, the opportunity's own id
    // was the only order in scope, the order read by it came back empty, and
    // not one of the orders under the opportunity was read.
    const dir = makeTmpDir();
    const extractor = extractorOver(
      {
        Opportunity: [{ Id: OPPORTUNITY }],
        FeedItem: [{ Id: FEED_ITEM, ParentId: OPPORTUNITY }],
        Order: [
          { Id: FIRST_ORDER, OpportunityId: OPPORTUNITY },
          { Id: SECOND_ORDER, OpportunityId: OPPORTUNITY },
          { Id: OTHER_ORDER, OpportunityId: to18('006A00000000oth') },
        ],
      },
      {
        FeedItem: [id, lookup('ParentId', ['Opportunity', 'Order'], false)],
        Order: [id, lookup('OpportunityId', ['Opportunity'])],
      },
    );

    const dataset = await extractor.extract({
      ...makeOptions(dir, []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [makeNode('Opportunity', 0), makeNode('FeedItem', 1), makeNode('Order', 1)],
        [
          edge('Opportunity', 'FeedItem', 'Feeds'),
          edge('Order', 'FeedItem', 'Feeds'),
          edge('Opportunity', 'Order', 'Orders'),
        ],
      ),
    });

    expect(sourceIdsOf(dataset, 'FeedItem')).toEqual([FEED_ITEM]);
    expect(sourceIdsOf(dataset, 'Order')).toEqual([FIRST_ORDER, SECOND_ORDER].sort());
  });

  it('keeps the price a quote line names when its book prices the product another way too', async () => {
    // A book holds a product's price once per selling model, and the dataset
    // keeps one price per book and product. Read under the book and the
    // product in scope, the catalog brought prices no line names; run for
    // real, one of them took the place of the price two quote lines used, and
    // those lines were left pointing at nothing.
    const dir = makeTmpDir();
    const BOOK = to18('01sA00000000bok');
    const PRODUCT = to18('01tA00000000prd');
    const QUOTE = to18('0Q0A00000000quo');
    const LINE = to18('0QLA00000000lin');
    const NAMED_PRICE = to18('01uA00000000zzz');
    const OTHER_PRICE = to18('01uA00000000aaa');
    const extractor = extractorOver(
      {
        Opportunity: [{ Id: OPPORTUNITY, Pricebook2Id: BOOK }],
        Pricebook2: [{ Id: BOOK, IsStandard: false }],
        Quote: [{ Id: QUOTE, OpportunityId: OPPORTUNITY, Pricebook2Id: BOOK }],
        QuoteLineItem: [
          { Id: LINE, QuoteId: QUOTE, PricebookEntryId: NAMED_PRICE, Product2Id: PRODUCT },
        ],
        PricebookEntry: [
          { Id: NAMED_PRICE, Pricebook2Id: BOOK, Product2Id: PRODUCT, IsActive: true },
          { Id: OTHER_PRICE, Pricebook2Id: BOOK, Product2Id: PRODUCT, IsActive: true },
        ],
        Product2: [{ Id: PRODUCT }],
      },
      {
        Opportunity: [id, lookup('Pricebook2Id', ['Pricebook2'])],
        Quote: [
          id,
          lookup('OpportunityId', ['Opportunity']),
          lookup('Pricebook2Id', ['Pricebook2']),
        ],
        QuoteLineItem: [
          id,
          lookup('QuoteId', ['Quote'], false),
          lookup('PricebookEntryId', ['PricebookEntry'], false),
          lookup('Product2Id', ['Product2'], false),
        ],
        PricebookEntry: [
          id,
          lookup('Pricebook2Id', ['Pricebook2'], false),
          lookup('Product2Id', ['Product2'], false),
          { name: 'IsActive', type: 'boolean', referenceTo: [] },
        ],
      },
    );

    const dataset = await extractor.extract({
      ...makeOptions(dir, []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [
          makeNode('Opportunity', 0),
          makeNode('Pricebook2', 1),
          makeNode('Quote', 1),
          makeNode('QuoteLineItem', 2),
          makeNode('Product2', 2),
          makeNode('PricebookEntry', 2),
        ],
        [
          edge('Pricebook2', 'Opportunity', 'Opportunities'),
          edge('Opportunity', 'Quote', 'Quotes'),
          edge('Pricebook2', 'Quote', 'Quotes'),
          edge('Quote', 'QuoteLineItem', 'QuoteLineItems'),
          edge('PricebookEntry', 'QuoteLineItem', 'QuoteLineItems'),
          edge('Product2', 'QuoteLineItem', 'QuoteLineItems'),
          edge('Pricebook2', 'PricebookEntry', 'PricebookEntries'),
          edge('Product2', 'PricebookEntry', 'PricebookEntries'),
        ],
      ),
    });

    expect(sourceIdsOf(dataset, 'QuoteLineItem')).toEqual([LINE]);
    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([NAMED_PRICE]);
  });

  it('leaves out the line items of an opportunity met through a quote of the account', async () => {
    // The account's quotes are its children and stay in the dataset, another
    // opportunity's among them. That opportunity's id, met once Opportunity
    // had been read, is no parent in scope: read under it, its line items
    // came in, and with them the opportunity itself, fetched as the parent
    // they require.
    const dir = makeTmpDir();
    const OTHER_OPPORTUNITY = to18('006A00000000oth');
    const OWN_QUOTE = to18('0Q0A00000000own');
    const OTHER_QUOTE = to18('0Q0A00000000oth');
    const OWN_LINE = to18('00kA00000000own');
    const OTHER_LINE = to18('00kA00000000oth');
    const extractor = extractorOver(
      {
        Opportunity: [
          { Id: OPPORTUNITY, AccountId: ACCOUNT },
          { Id: OTHER_OPPORTUNITY, AccountId: ACCOUNT },
        ],
        Account: [{ Id: ACCOUNT }],
        Quote: [
          { Id: OWN_QUOTE, OpportunityId: OPPORTUNITY, AccountId: ACCOUNT },
          { Id: OTHER_QUOTE, OpportunityId: OTHER_OPPORTUNITY, AccountId: ACCOUNT },
        ],
        OpportunityLineItem: [
          { Id: OWN_LINE, OpportunityId: OPPORTUNITY },
          { Id: OTHER_LINE, OpportunityId: OTHER_OPPORTUNITY },
        ],
      },
      {
        Opportunity: [id, lookup('AccountId', ['Account'])],
        Quote: [id, lookup('OpportunityId', ['Opportunity']), lookup('AccountId', ['Account'])],
        OpportunityLineItem: [id, lookup('OpportunityId', ['Opportunity'], false)],
      },
    );

    const dataset = await extractor.extract({
      ...makeOptions(dir, []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [
          makeNode('Opportunity', 0),
          makeNode('Account', 1),
          makeNode('Quote', 1),
          makeNode('OpportunityLineItem', 1),
        ],
        [
          edge('Account', 'Opportunity', 'Opportunities'),
          edge('Account', 'Quote', 'Quotes'),
          edge('Opportunity', 'Quote', 'Quotes'),
          edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems'),
        ],
      ),
    });

    expect(sourceIdsOf(dataset, 'Quote')).toEqual([OWN_QUOTE, OTHER_QUOTE].sort());
    expect(sourceIdsOf(dataset, 'OpportunityLineItem')).toEqual([OWN_LINE]);
    expect(sourceIdsOf(dataset, 'Opportunity')).toEqual([OPPORTUNITY]);
  });
});

describe('FrozenDatasetExtractor — the standard prices of the products a dossier prices', () => {
  const STANDARD_BOOK = to18('01sA00000000std');
  const CUSTOM_BOOK = to18('01sA00000000cus');
  const opportunity = (currency: string): string => to18(`006A00000000${currency}`);
  const product = (n: number): string => to18(`01tA${String(n).padStart(11, '0')}`);
  const line = (n: number, currency: string): string =>
    to18(`00k${currency}${String(n).padStart(9, '0')}`);
  const price = (book: 'C' | 'S', n: number, currency: string): string =>
    to18(`01u${book}${currency}${String(n).padStart(8, '0')}`);

  /**
   * One opportunity per currency, each with a line per product priced from
   * the custom book in its currency; the standard book prices every product
   * in every currency of `standardIn`.
   */
  function dossiers(
    products: number,
    currencies: readonly string[],
    standardIn: readonly string[] = currencies,
  ): Record<string, FakeRow[]> {
    const numbers = Array.from({ length: products }, (_, i) => i + 1);
    return {
      Opportunity: currencies.map((c) => ({
        Id: opportunity(c),
        Pricebook2Id: CUSTOM_BOOK,
        CurrencyIsoCode: c,
      })),
      Pricebook2: [
        { Id: STANDARD_BOOK, IsStandard: true },
        { Id: CUSTOM_BOOK, IsStandard: false },
      ],
      Product2: numbers.map((n) => ({ Id: product(n) })),
      OpportunityLineItem: currencies.flatMap((c) =>
        numbers.map((n) => ({
          Id: line(n, c),
          OpportunityId: opportunity(c),
          PricebookEntryId: price('C', n, c),
          Product2Id: product(n),
          CurrencyIsoCode: c,
        })),
      ),
      PricebookEntry: numbers.flatMap((n) => [
        ...currencies.map((c) => ({
          Id: price('C', n, c),
          Pricebook2Id: CUSTOM_BOOK,
          Product2Id: product(n),
          IsActive: true,
          CurrencyIsoCode: c,
        })),
        ...standardIn.map((c) => ({
          Id: price('S', n, c),
          Pricebook2Id: STANDARD_BOOK,
          Product2Id: product(n),
          IsActive: true,
          CurrencyIsoCode: c,
        })),
      ]),
    };
  }

  const currency: ScopableField = { name: 'CurrencyIsoCode', type: 'picklist', referenceTo: [] };
  const describedAs = (priceFields: ScopableField[] = []): Record<string, ScopableField[]> => ({
    Opportunity: [id, lookup('Pricebook2Id', ['Pricebook2']), currency],
    Pricebook2: [id, { name: 'IsStandard', type: 'boolean', referenceTo: [] }],
    OpportunityLineItem: [
      id,
      lookup('OpportunityId', ['Opportunity'], false),
      lookup('PricebookEntryId', ['PricebookEntry'], false),
      lookup('Product2Id', ['Product2']),
      currency,
    ],
    PricebookEntry: [
      id,
      lookup('Pricebook2Id', ['Pricebook2'], false),
      lookup('Product2Id', ['Product2'], false),
      { name: 'IsActive', type: 'boolean', referenceTo: [] },
      currency,
      ...priceFields,
    ],
  });

  const graph = graphOf(
    [
      makeNode('Opportunity', 0),
      makeNode('Pricebook2', 1),
      makeNode('OpportunityLineItem', 1),
      makeNode('Product2', 2),
      makeNode('PricebookEntry', 2),
    ],
    [
      edge('Pricebook2', 'Opportunity', 'Opportunities'),
      edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems'),
      edge('PricebookEntry', 'OpportunityLineItem', 'OpportunityLineItems'),
      edge('Product2', 'OpportunityLineItem', 'OpportunityLineItems'),
      edge('Pricebook2', 'PricebookEntry', 'PricebookEntries'),
      edge('Product2', 'PricebookEntry', 'PricebookEntries'),
    ],
  );

  /** Extract the dossiers, reading the org the way Salesforce answers a query URI. */
  async function extractFrom(
    tables: Record<string, FakeRow[]>,
    fields: Record<string, ScopableField[]>,
    roots: string[],
  ): Promise<{ dataset: ExtractedDataset; sent: string[] }> {
    const sent: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        sent.push(soql);
        // Salesforce refuses a request URI much past 16 000 characters.
        if (encodeURIComponent(soql).length > 16_000) throw new Error('414 URI Too Long');
        return soql.includes('FROM RecordType') ? [] : selectRows(tables, soql);
      },
      describeFields: async (objectApiName) => fields[objectApiName] ?? [id],
    });
    const dataset = await extractor.extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: roots,
      graph,
    });
    return { dataset, sent };
  }

  const standardPricesOf = (dataset: ExtractedDataset): Record<string, unknown>[] =>
    (dataset.objects.find((o) => o.objectApiName === 'PricebookEntry')?.records ?? [])
      .map((r) => r.fields)
      .filter((f) => f.Pricebook2Id === STANDARD_BOOK);

  it('reads the standard price of each of seven hundred products', async () => {
    const { dataset, sent } = await extractFrom(dossiers(700, ['EUR']), describedAs(), [
      opportunity('EUR'),
    ]);

    expect(standardPricesOf(dataset).map((f) => f.Product2Id)).toEqual(
      Array.from({ length: 700 }, (_, i) => product(i + 1)).sort(),
    );
    expect(sent.filter((soql) => encodeURIComponent(soql).length > 16_000)).toEqual([]);
  });

  it('takes the standard price of each currency a custom price is in, and of no other', async () => {
    // An org with several currencies prices a product once per currency, and
    // a custom price needs the standard price of its own currency. Taken by
    // product, the prices in euros and dollars brought the pound price too,
    // which no price of the dataset needs.
    const { dataset } = await extractFrom(
      dossiers(2, ['EUR', 'USD'], ['EUR', 'USD', 'GBP']),
      describedAs(),
      [opportunity('EUR'), opportunity('USD')],
    );

    const standard = standardPricesOf(dataset);
    for (const n of [1, 2]) {
      const currencies = standard
        .filter((f) => f.Product2Id === product(n))
        .map((f) => f.CurrencyIsoCode)
        .sort();
      expect(currencies).toEqual(['EUR', 'USD']);
    }

    // The load writes the standard prices first, those whose book is the one
    // the dataset names as standard, and matches that book to the target's.
    const frozen = new FrozenDatasetAnonymizer().anonymize({
      extracted: dataset,
      rules: parsePseudonymRules({ rulesVersion: '1.0.0', rules: {} }),
      pseudonymizer: new DeterministicPseudonymizer('standard-prices-test-salt'),
      datasetVersion: '1.0.0',
    });
    const standardBook = dataset.objects
      .find((o) => o.objectApiName === 'Pricebook2')
      ?.records.find((r) => r.sourceId === STANDARD_BOOK)?.referenceId;
    expect(dataset.standardPricebookSourceId).toBe(STANDARD_BOOK);
    expect(frozen.standardPricebook).toBe(standardBook);
    const frozenPrices =
      frozen.objects.find((o) => o.objectApiName === 'PricebookEntry')?.records ?? [];
    expect(
      frozenPrices.filter((r) => r.fields.Pricebook2Id === frozen.standardPricebook),
    ).toHaveLength(standard.length);
  });

  it('takes the standard price of the selling model a custom price is sold under', async () => {
    // A product priced under two selling models holds a standard price under
    // each, and the dataset keeps one standard price per product and
    // currency. Taken by product, the one under the other model came first
    // and stayed; the custom price was left with no standard price of its own
    // model, which the platform requires.
    const SOLD_UNDER = to18('0jPA00000000sub');
    const OTHER_MODEL = to18('0jPA00000000oth');
    const tables = dossiers(1, ['EUR']);
    const standardUnder = (model: string, suffix: string): FakeRow => ({
      Id: to18(`01uS00000000${suffix}`),
      Pricebook2Id: STANDARD_BOOK,
      Product2Id: product(1),
      IsActive: true,
      CurrencyIsoCode: 'EUR',
      ProductSellingModelId: model,
    });
    tables.PricebookEntry = [
      { ...tables.PricebookEntry[0], ProductSellingModelId: SOLD_UNDER },
      standardUnder(OTHER_MODEL, 'smA'),
      standardUnder(SOLD_UNDER, 'smB'),
    ];

    const { dataset } = await extractFrom(
      tables,
      describedAs([lookup('ProductSellingModelId', ['ProductSellingModel'])]),
      [opportunity('EUR')],
    );

    expect(standardPricesOf(dataset).map((f) => f.ProductSellingModelId)).toEqual([SOLD_UNDER]);
  });

  it('reads the standard prices of a price object hundreds of fields wide', async () => {
    // Two hundred products a statement, whatever the width of the field list
    // written in front of them: past some four hundred fields a statement no
    // longer fits the request URI, the org refuses it, and the extraction
    // stops there.
    const wide = Array.from({ length: 420 }, (_, i) => ({
      name: `Price_Attribute_${String(i).padStart(3, '0')}__c`,
      type: 'string',
      referenceTo: [],
    }));
    const { dataset, sent } = await extractFrom(dossiers(200, ['EUR']), describedAs(wide), [
      opportunity('EUR'),
    ]);

    expect(standardPricesOf(dataset)).toHaveLength(200);
    expect(sent.filter((soql) => encodeURIComponent(soql).length > 16_000)).toEqual([]);
  });
});

describe('FrozenDatasetExtractor — the catalog a dossier draws on', () => {
  const OPPORTUNITY = to18('006A00000000opp');
  const OTHER_OPPORTUNITY = to18('006A00000000oth');
  const BOOK = to18('01sA00000000bok');
  const STANDARD_BOOK = to18('01sA00000000std');
  const PRODUCT = to18('01tA00000000prd');
  const PRICE = to18('01uA00000000prc');
  const STANDARD_PRICE = to18('01uA00000000std');
  const LINE = to18('00kA00000000lin');

  const isActive: ScopableField = { name: 'IsActive', type: 'boolean', referenceTo: [] };
  const priceFields: ScopableField[] = [
    id,
    lookup('Pricebook2Id', ['Pricebook2'], false),
    lookup('Product2Id', ['Product2'], false),
    lookup('ProductSellingModelId', ['ProductSellingModel']),
    isActive,
  ];

  it('reads no quote or order of another opportunity through the book the opportunity names', async () => {
    // The opportunity's price book is also the book of every other sale
    // priced from it. Read as a parent in scope, it brought the quotes and
    // orders that use it, another opportunity's among them.
    const OWN_QUOTE = to18('0Q0A00000000own');
    const OTHER_QUOTE = to18('0Q0A00000000oth');
    const OWN_ORDER = to18('801A00000000own');
    const OTHER_ORDER = to18('801A00000000oth');
    const sold = (row: FakeRow): FakeRow => ({ ...row, Pricebook2Id: BOOK });
    const extractor = extractorOver(
      {
        Opportunity: [sold({ Id: OPPORTUNITY }), sold({ Id: OTHER_OPPORTUNITY })],
        Pricebook2: [{ Id: BOOK }],
        Quote: [
          sold({ Id: OWN_QUOTE, OpportunityId: OPPORTUNITY }),
          sold({ Id: OTHER_QUOTE, OpportunityId: OTHER_OPPORTUNITY }),
        ],
        Order: [
          sold({ Id: OWN_ORDER, OpportunityId: OPPORTUNITY }),
          sold({ Id: OTHER_ORDER, OpportunityId: OTHER_OPPORTUNITY }),
        ],
      },
      {
        Opportunity: [id, lookup('Pricebook2Id', ['Pricebook2'])],
        Quote: [
          id,
          lookup('OpportunityId', ['Opportunity']),
          lookup('Pricebook2Id', ['Pricebook2']),
        ],
        Order: [
          id,
          lookup('OpportunityId', ['Opportunity']),
          lookup('Pricebook2Id', ['Pricebook2']),
        ],
      },
    );

    const dataset = await extractor.extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [
          makeNode('Opportunity', 0),
          makeNode('Pricebook2', 1),
          makeNode('Quote', 1),
          makeNode('Order', 1),
        ],
        [
          edge('Pricebook2', 'Opportunity', 'Opportunities'),
          edge('Opportunity', 'Quote', 'Quotes'),
          edge('Pricebook2', 'Quote', 'Quotes'),
          edge('Opportunity', 'Order', 'Orders'),
          edge('Pricebook2', 'Order', 'Orders'),
        ],
      ),
    });

    expect(sourceIdsOf(dataset, 'Quote')).toEqual([OWN_QUOTE]);
    expect(sourceIdsOf(dataset, 'Order')).toEqual([OWN_ORDER]);
    expect(sourceIdsOf(dataset, 'Opportunity')).toEqual([OPPORTUNITY]);
  });

  it('reads what is under a catalog row the extraction reached from above', async () => {
    // A product's dossier: its prices are under the root, and the lines sold
    // at those prices under them. Only a catalog row met through a lookup
    // brings nothing.
    const OTHER_PRODUCT = to18('01tA00000000oth');
    const OTHER_PRICE = to18('01uA00000000oth');
    const OTHER_LINE = to18('00kA00000000oth');
    const extractor = extractorOver(
      {
        Product2: [{ Id: PRODUCT }, { Id: OTHER_PRODUCT }],
        Pricebook2: [{ Id: BOOK }],
        PricebookEntry: [
          { Id: PRICE, Pricebook2Id: BOOK, Product2Id: PRODUCT, IsActive: true },
          { Id: OTHER_PRICE, Pricebook2Id: BOOK, Product2Id: OTHER_PRODUCT, IsActive: true },
        ],
        OpportunityLineItem: [
          { Id: LINE, PricebookEntryId: PRICE },
          { Id: OTHER_LINE, PricebookEntryId: OTHER_PRICE },
        ],
      },
      {
        PricebookEntry: priceFields,
        OpportunityLineItem: [id, lookup('PricebookEntryId', ['PricebookEntry'])],
      },
    );

    const dataset = await extractor.extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Product2',
      rootRecordIds: [PRODUCT],
      graph: graphOf(
        [
          makeNode('Product2', 0),
          makeNode('PricebookEntry', 1),
          makeNode('OpportunityLineItem', 2),
        ],
        [
          edge('Product2', 'PricebookEntry', 'PricebookEntries'),
          edge('PricebookEntry', 'OpportunityLineItem', 'OpportunityLineItems'),
        ],
      ),
    });

    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([PRICE]);
    expect(sourceIdsOf(dataset, 'OpportunityLineItem')).toEqual([LINE]);
  });

  it('keeps both prices of a product a book sells under two selling models', async () => {
    // A book prices a product once per selling model it is sold under, and
    // each line here uses one of them. Kept one price per book and product,
    // the dataset lost the second line's price. And read before the prices
    // named them, the selling models came out empty, so the load could not
    // have told the two prices apart.
    const ONE_TIME = to18('0jPA00000000one');
    const TERMED = to18('0jPA00000000trm');
    const ONE_TIME_PRICE = to18('01uA00000000one');
    const TERMED_PRICE = to18('01uA00000000trm');
    const SECOND_LINE = to18('00kA00000000sec');
    const line = (lineId: string, priceId: string): FakeRow => ({
      Id: lineId,
      OpportunityId: OPPORTUNITY,
      PricebookEntryId: priceId,
    });
    const price = (priceId: string, model: string): FakeRow => ({
      Id: priceId,
      Pricebook2Id: BOOK,
      Product2Id: PRODUCT,
      ProductSellingModelId: model,
      IsActive: true,
    });
    const extractor = extractorOver(
      {
        Opportunity: [{ Id: OPPORTUNITY, Pricebook2Id: BOOK }],
        Pricebook2: [{ Id: BOOK }],
        Product2: [{ Id: PRODUCT }],
        ProductSellingModel: [{ Id: ONE_TIME }, { Id: TERMED }],
        PricebookEntry: [price(ONE_TIME_PRICE, ONE_TIME), price(TERMED_PRICE, TERMED)],
        OpportunityLineItem: [line(LINE, ONE_TIME_PRICE), line(SECOND_LINE, TERMED_PRICE)],
      },
      {
        Opportunity: [id, lookup('Pricebook2Id', ['Pricebook2'])],
        OpportunityLineItem: [
          id,
          lookup('OpportunityId', ['Opportunity'], false),
          lookup('PricebookEntryId', ['PricebookEntry']),
        ],
        PricebookEntry: priceFields,
      },
    );

    const dataset = await extractor.extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [
          makeNode('Opportunity', 0),
          makeNode('ProductSellingModel', 1),
          makeNode('Pricebook2', 1),
          makeNode('OpportunityLineItem', 1),
          makeNode('PricebookEntry', 2),
          makeNode('Product2', 2),
        ],
        [
          edge('Pricebook2', 'Opportunity', 'Opportunities'),
          edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems'),
          edge('PricebookEntry', 'OpportunityLineItem', 'OpportunityLineItems'),
          edge('Pricebook2', 'PricebookEntry', 'PricebookEntries'),
          edge('Product2', 'PricebookEntry', 'PricebookEntries'),
          edge('ProductSellingModel', 'PricebookEntry', 'PricebookEntries'),
        ],
      ),
    });

    expect(sourceIdsOf(dataset, 'OpportunityLineItem')).toEqual([LINE, SECOND_LINE].sort());
    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([ONE_TIME_PRICE, TERMED_PRICE].sort());
    expect(sourceIdsOf(dataset, 'ProductSellingModel')).toEqual([ONE_TIME, TERMED].sort());
  });

  /** An opportunity with one priced line, and the catalog behind it: its book and the standard one. */
  function pricedDossier(): Record<string, FakeRow[]> {
    return {
      Opportunity: [{ Id: OPPORTUNITY, Pricebook2Id: BOOK }],
      OpportunityLineItem: [{ Id: LINE, OpportunityId: OPPORTUNITY, PricebookEntryId: PRICE }],
      Pricebook2: [
        { Id: BOOK, IsStandard: false },
        { Id: STANDARD_BOOK, IsStandard: true },
      ],
      Product2: [{ Id: PRODUCT }],
      PricebookEntry: [
        { Id: PRICE, Pricebook2Id: BOOK, Product2Id: PRODUCT, IsActive: true },
        { Id: STANDARD_PRICE, Pricebook2Id: STANDARD_BOOK, Product2Id: PRODUCT, IsActive: true },
      ],
    };
  }

  const lineFields: Record<string, ScopableField[]> = {
    Opportunity: [id, lookup('Pricebook2Id', ['Pricebook2'])],
    // As the org describes it: nullable, and refused at insert without it.
    OpportunityLineItem: [
      id,
      lookup('OpportunityId', ['Opportunity'], false),
      lookup('PricebookEntryId', ['PricebookEntry']),
    ],
    Pricebook2: [id, { name: 'IsStandard', type: 'boolean', referenceTo: [] }],
    PricebookEntry: priceFields,
  };

  it('carries the prices, products and books of its lines when discovery stopped short of the catalog', async () => {
    // Run for real at the default cap of fifty objects: discovery stopped
    // before it reached the catalog, and a dossier with three priced lines
    // came out without a single price.
    const dataset = await extractorOver(pricedDossier(), lineFields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [makeNode('Opportunity', 0), makeNode('OpportunityLineItem', 1)],
        [edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems')],
      ),
    });

    expect(sourceIdsOf(dataset, 'OpportunityLineItem')).toEqual([LINE]);
    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([PRICE, STANDARD_PRICE].sort());
    expect(sourceIdsOf(dataset, 'Product2')).toEqual([PRODUCT]);
    expect(sourceIdsOf(dataset, 'Pricebook2')).toEqual([BOOK, STANDARD_BOOK].sort());
    expect(dataset.standardPricebookSourceId).toBe(STANDARD_BOOK);
  });

  it('leaves the catalog out where the graph leaves it out', async () => {
    const excluded = { ...makeNode('PricebookEntry', 2), included: false };
    const dataset = await extractorOver(pricedDossier(), lineFields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [makeNode('Opportunity', 0), makeNode('OpportunityLineItem', 1), excluded],
        [edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems')],
      ),
    });

    expect(sourceIdsOf(dataset, 'OpportunityLineItem')).toEqual([LINE]);
    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([]);
  });

  /** Discovery stopped at the lines, as it does at the default cap: the catalog is past it. */
  const upToTheLines = (): ForgeGraph =>
    graphOf(
      [makeNode('Opportunity', 0), makeNode('OpportunityLineItem', 1)],
      [edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems')],
    );

  it('fetches no price excludedObjects names past the cap, and says which lines cannot be loaded without it', async () => {
    // Marked on the graph's node alone, an object discovery never reached
    // was no exclusion: the extraction fetched the prices all the same.
    const dataset = await extractorOver(pricedDossier(), lineFields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: upToTheLines(),
      excludedObjects: ['PricebookEntry'],
    });

    // The line is the dossier's, and stays in it.
    expect(sourceIdsOf(dataset, 'OpportunityLineItem')).toEqual([LINE]);
    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([]);
    expect(sourceIdsOf(dataset, 'Product2')).toEqual([]);
    expect(dataset.exclusionCosts).toEqual([
      {
        objectApiName: 'OpportunityLineItem',
        excludedObject: 'PricebookEntry',
        count: 1,
        note:
          '1 OpportunityLineItem record cannot be loaded without the PricebookEntry named by ' +
          'PricebookEntryId, which excludedObjects leaves out',
      },
    ]);
  });

  it('leaves out a node of the graph excludedObjects names', async () => {
    const dataset = await extractorOver(pricedDossier(), lineFields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [
          makeNode('Opportunity', 0),
          makeNode('OpportunityLineItem', 1),
          makeNode('PricebookEntry', 2),
        ],
        [
          edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems'),
          edge('PricebookEntry', 'OpportunityLineItem', 'OpportunityLineItems'),
        ],
      ),
      excludedObjects: ['PricebookEntry'],
    });

    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([]);
    expect(dataset.exclusionCosts).toEqual([
      expect.objectContaining({ objectApiName: 'OpportunityLineItem', count: 1 }),
    ]);
  });

  it('fetches no price book excludedObjects names, the standard one included, and says which prices cannot be loaded without it', async () => {
    // The standard book is read whatever the graph holds: it came into the
    // dataset of a configuration that excluded the price books.
    const dataset = await extractorOver(pricedDossier(), lineFields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: upToTheLines(),
      excludedObjects: ['Pricebook2'],
    });

    expect(sourceIdsOf(dataset, 'Pricebook2')).toEqual([]);
    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([PRICE, STANDARD_PRICE].sort());
    expect(dataset.exclusionCosts).toEqual([
      {
        objectApiName: 'PricebookEntry',
        excludedObject: 'Pricebook2',
        count: 2,
        note:
          '2 PricebookEntry records cannot be loaded without the Pricebook2 named by ' +
          'Pricebook2Id, which excludedObjects leaves out',
      },
    ]);
  });

  it('says nothing of an exclusion that costs the dataset nothing', async () => {
    const dataset = await extractorOver(pricedDossier(), lineFields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: upToTheLines(),
      excludedObjects: ['Case'],
    });

    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([PRICE, STANDARD_PRICE].sort());
    expect(dataset.exclusionCosts).toBeUndefined();
  });
});

describe('FrozenDatasetExtractor — the selling model options its prices need', () => {
  const OPPORTUNITY = to18('006A00000000opp');
  const BOOK = to18('01sA00000000bok');
  const STANDARD_BOOK = to18('01sA00000000std');
  const PRODUCT = to18('01tA00000000prd');
  const UNSOLD_PRODUCT = to18('01tA00000000uns');
  const MODEL = to18('0jPA00000000one');
  const OTHER_MODEL = to18('0jPA00000000trm');
  const PRICE = to18('01uA00000000prc');
  const STANDARD_PRICE = to18('01uA00000000std');
  const LINE = to18('00kA00000000lin');
  const OPTION = to18('0iOA00000000opt');
  const OPTION_UNDER_OTHER_MODEL = to18('0iOA00000000oth');
  const OPTION_OF_UNSOLD_PRODUCT = to18('0iOA00000000uns');

  /**
   * An opportunity with one line, priced under a selling model from its book;
   * the standard price under the same model; and the options the source
   * holds: the one the prices need, and two no price of the dossier names.
   */
  const tables: Record<string, FakeRow[]> = {
    Opportunity: [{ Id: OPPORTUNITY, Pricebook2Id: BOOK }],
    OpportunityLineItem: [{ Id: LINE, OpportunityId: OPPORTUNITY, PricebookEntryId: PRICE }],
    Pricebook2: [
      { Id: BOOK, IsStandard: false },
      { Id: STANDARD_BOOK, IsStandard: true },
    ],
    Product2: [{ Id: PRODUCT }, { Id: UNSOLD_PRODUCT }],
    ProductSellingModel: [{ Id: MODEL }, { Id: OTHER_MODEL }],
    PricebookEntry: [
      {
        Id: PRICE,
        Pricebook2Id: BOOK,
        Product2Id: PRODUCT,
        ProductSellingModelId: MODEL,
        IsActive: true,
      },
      {
        Id: STANDARD_PRICE,
        Pricebook2Id: STANDARD_BOOK,
        Product2Id: PRODUCT,
        ProductSellingModelId: MODEL,
        IsActive: true,
      },
    ],
    ProductSellingModelOption: [
      { Id: OPTION, Product2Id: PRODUCT, ProductSellingModelId: MODEL },
      { Id: OPTION_UNDER_OTHER_MODEL, Product2Id: PRODUCT, ProductSellingModelId: OTHER_MODEL },
      { Id: OPTION_OF_UNSOLD_PRODUCT, Product2Id: UNSOLD_PRODUCT, ProductSellingModelId: MODEL },
    ],
  };
  const fields: Record<string, ScopableField[]> = {
    Opportunity: [id, lookup('Pricebook2Id', ['Pricebook2'])],
    OpportunityLineItem: [
      id,
      lookup('OpportunityId', ['Opportunity'], false),
      lookup('PricebookEntryId', ['PricebookEntry']),
    ],
    Pricebook2: [id, { name: 'IsStandard', type: 'boolean', referenceTo: [] }],
    PricebookEntry: [
      id,
      lookup('Pricebook2Id', ['Pricebook2'], false),
      lookup('Product2Id', ['Product2'], false),
      lookup('ProductSellingModelId', ['ProductSellingModel']),
      { name: 'IsActive', type: 'boolean', referenceTo: [] },
    ],
    ProductSellingModelOption: [
      id,
      lookup('Product2Id', ['Product2'], false),
      lookup('ProductSellingModelId', ['ProductSellingModel'], false),
    ],
  };
  /** Discovery stopped at the lines, as it does at the default cap: the catalog is past it. */
  const upToTheLines = (...more: ForgeGraphNode[]): ForgeGraph =>
    graphOf(
      [makeNode('Opportunity', 0), makeNode('OpportunityLineItem', 1), ...more],
      [edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems')],
    );

  it('carries the option each price needs to sell its product under its model', async () => {
    // The platform takes no price for a product under a model the product
    // has no option for, standard price included, and nothing points at an
    // option: the dataset carried the model and both prices, and not the
    // option, so every price under the model would have been refused.
    const dataset = await extractorOver(tables, fields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: upToTheLines(),
    });

    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([PRICE, STANDARD_PRICE].sort());
    expect(sourceIdsOf(dataset, 'ProductSellingModel')).toEqual([MODEL]);
    expect(sourceIdsOf(dataset, 'ProductSellingModelOption')).toEqual([OPTION]);
  });

  it('leaves the options out where the graph leaves them out', async () => {
    const excluded = { ...makeNode('ProductSellingModelOption', 3), included: false };
    const dataset = await extractorOver(tables, fields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: upToTheLines(excluded),
    });

    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([PRICE, STANDARD_PRICE].sort());
    expect(sourceIdsOf(dataset, 'ProductSellingModelOption')).toEqual([]);
  });

  it('carries no option for a model the dataset leaves out', async () => {
    // An option is written with its model, and the load has none to write.
    const excluded = { ...makeNode('ProductSellingModel', 3), included: false };
    const dataset = await extractorOver(tables, fields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: upToTheLines(excluded),
    });

    expect(sourceIdsOf(dataset, 'ProductSellingModel')).toEqual([]);
    expect(sourceIdsOf(dataset, 'ProductSellingModelOption')).toEqual([]);
  });

  it('reads no option excludedObjects names, and says which prices cannot be loaded without one', async () => {
    // Nothing points at an option, so the graph holds none: marked on its
    // nodes alone, the exclusion left the options to be read all the same.
    const dataset = await extractorOver(tables, fields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: upToTheLines(),
      excludedObjects: ['ProductSellingModelOption'],
    });

    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([PRICE, STANDARD_PRICE].sort());
    expect(sourceIdsOf(dataset, 'ProductSellingModelOption')).toEqual([]);
    expect(dataset.exclusionCosts).toEqual([
      {
        objectApiName: 'PricebookEntry',
        excludedObject: 'ProductSellingModelOption',
        count: 2,
        note:
          '2 PricebookEntry records sold under a selling model cannot be loaded without the ' +
          'option that sells the product under it, and excludedObjects leaves ' +
          'ProductSellingModelOption out',
      },
    ]);
  });
});

describe('FrozenDatasetExtractor — the items an order past Draft needs', () => {
  const OPPORTUNITY = to18('006A00000000opp');
  const ACTIVATED = to18('801A00000000act');
  const DRAFT = to18('801A00000000drf');
  const ACTIVATED_ITEM = to18('802A00000000act');
  const DRAFT_ITEM = to18('802A00000000drf');
  const BOOK = to18('01sA00000000bok');
  const STANDARD_BOOK = to18('01sA00000000std');
  const PRODUCT = to18('01tA00000000prd');
  const PRICE = to18('01uA00000000prc');
  const STANDARD_PRICE = to18('01uA00000000std');
  const ORDER_STATUSES = 'SELECT ApiName, StatusCode FROM OrderStatus';

  /**
   * An opportunity with two orders, one item on each, priced from the
   * opportunity's book: the first order in `firstStatus`, the second a draft.
   */
  function tables(firstStatus = 'Live'): Record<string, FakeRow[]> {
    return {
      Opportunity: [{ Id: OPPORTUNITY, Pricebook2Id: BOOK }],
      Order: [
        { Id: ACTIVATED, OpportunityId: OPPORTUNITY, Status: firstStatus },
        { Id: DRAFT, OpportunityId: OPPORTUNITY, Status: 'Open' },
      ],
      OrderItem: [
        { Id: ACTIVATED_ITEM, OrderId: ACTIVATED, PricebookEntryId: PRICE },
        { Id: DRAFT_ITEM, OrderId: DRAFT, PricebookEntryId: PRICE },
      ],
      Pricebook2: [
        { Id: BOOK, IsStandard: false },
        { Id: STANDARD_BOOK, IsStandard: true },
      ],
      Product2: [{ Id: PRODUCT }],
      PricebookEntry: [
        { Id: PRICE, Pricebook2Id: BOOK, Product2Id: PRODUCT, IsActive: true },
        { Id: STANDARD_PRICE, Pricebook2Id: STANDARD_BOOK, Product2Id: PRODUCT, IsActive: true },
      ],
    };
  }
  const fields: Record<string, ScopableField[]> = {
    Opportunity: [id, lookup('Pricebook2Id', ['Pricebook2'])],
    Order: [
      id,
      lookup('OpportunityId', ['Opportunity']),
      { name: 'Status', type: 'picklist', referenceTo: [] },
    ],
    OrderItem: [
      id,
      lookup('OrderId', ['Order'], false),
      lookup('PricebookEntryId', ['PricebookEntry'], false),
    ],
    Pricebook2: [id, { name: 'IsStandard', type: 'boolean', referenceTo: [] }],
    PricebookEntry: [
      id,
      lookup('Pricebook2Id', ['Pricebook2'], false),
      lookup('Product2Id', ['Product2'], false),
      { name: 'IsActive', type: 'boolean', referenceTo: [] },
    ],
  };

  /**
   * The source in miniature, whose order statuses are `Open`, a draft, and
   * `Live`, an activated one — or which cannot say, when `statuses` throws.
   */
  function extractorOverOrders(
    rows: Record<string, FakeRow[]>,
    statuses: () => FakeRow[] = () => [
      { ApiName: 'Open', StatusCode: 'Draft' },
      { ApiName: 'Live', StatusCode: 'Activated' },
    ],
  ): { extractor: FrozenDatasetExtractor; sent: string[] } {
    const sent: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        sent.push(soql);
        if (soql === ORDER_STATUSES) return statuses();
        return soql.includes('FROM RecordType') ? [] : selectRows(rows, soql);
      },
      describeFields: async (objectApiName) => fields[objectApiName] ?? [id],
    });
    return { extractor, sent };
  }

  /** Discovery stopped at the orders, as the default cap did around an opportunity. */
  function upToTheOrders(...more: ForgeGraphNode[]): ForgeGraph {
    return graphOf(
      [makeNode('Opportunity', 0), makeNode('Order', 1), ...more],
      [edge('Opportunity', 'Order', 'Orders')],
    );
  }

  function extractFrom(extractor: FrozenDatasetExtractor, graph: ForgeGraph) {
    return extractor.extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph,
    });
  }

  it('carries the items of an order past Draft that discovery stopped before, and what they are priced from', async () => {
    // Extracted for real at the default cap, an opportunity's dossier held
    // its eleven orders and none of their items. A load writes an activated
    // order as a draft and activates it once the rest is written, and the
    // platform activates no order without a product on it.
    const { extractor } = extractorOverOrders(tables());

    const dataset = await extractFrom(extractor, upToTheOrders());

    expect(sourceIdsOf(dataset, 'Order')).toEqual([ACTIVATED, DRAFT].sort());
    // A draft goes in as it is and needs no item: the cap left its items
    // out, and out they stay.
    expect(sourceIdsOf(dataset, 'OrderItem')).toEqual([ACTIVATED_ITEM]);
    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([PRICE, STANDARD_PRICE].sort());
    expect(sourceIdsOf(dataset, 'Product2')).toEqual([PRODUCT]);
    expect(sourceIdsOf(dataset, 'Pricebook2')).toEqual([BOOK, STANDARD_BOOK].sort());
  });

  it('brings no item when no order it reads is past Draft', async () => {
    const { extractor } = extractorOverOrders(tables('Open'));

    const dataset = await extractFrom(extractor, upToTheOrders());

    expect(sourceIdsOf(dataset, 'Order')).toEqual([ACTIVATED, DRAFT].sort());
    expect(sourceIdsOf(dataset, 'OrderItem')).toEqual([]);
    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([]);
  });

  it('brings no item when the source cannot say which of its order statuses are drafts', async () => {
    const { extractor } = extractorOverOrders(tables(), () => {
      throw new Error("sObject type 'OrderStatus' is not supported.");
    });

    const dataset = await extractFrom(extractor, upToTheOrders());

    expect(sourceIdsOf(dataset, 'Order')).toEqual([ACTIVATED, DRAFT].sort());
    expect(sourceIdsOf(dataset, 'OrderItem')).toEqual([]);
  });

  it('leaves out the items of a graph that holds them and leaves them out', async () => {
    const { extractor, sent } = extractorOverOrders(tables());

    const dataset = await extractFrom(
      extractor,
      upToTheOrders({ ...makeNode('OrderItem', 2), included: false }),
    );

    expect(sourceIdsOf(dataset, 'OrderItem')).toEqual([]);
    expect(sent.filter((soql) => soql.includes('FROM OrderItem'))).toEqual([]);
  });

  it('reads no item excludedObjects names, and says which order will stay a draft', async () => {
    // Marked on the graph's node alone, an object discovery never reached
    // was no exclusion: the extraction brought the items all the same.
    const { extractor, sent } = extractorOverOrders(tables());

    const dataset = await extractor.extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: upToTheOrders(),
      excludedObjects: ['OrderItem'],
    });

    expect(sourceIdsOf(dataset, 'Order')).toEqual([ACTIVATED, DRAFT].sort());
    expect(sourceIdsOf(dataset, 'OrderItem')).toEqual([]);
    expect(sent.filter((soql) => soql.includes('FROM OrderItem'))).toEqual([]);
    // The draft needs no item: only the activated order pays.
    expect(dataset.exclusionCosts).toEqual([
      {
        objectApiName: 'Order',
        excludedObject: 'OrderItem',
        count: 1,
        note:
          '1 Order record past Draft will be loaded as a draft and stay so: the platform gives ' +
          'Order this status only with OrderItem records under it, and excludedObjects leaves ' +
          'OrderItem out',
      },
    ]);
  });

  it('says which order will stay a draft for the prices excludedObjects names, through its items', async () => {
    const { extractor } = extractorOverOrders(tables());

    const dataset = await extractor.extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: upToTheOrders(),
      excludedObjects: ['PricebookEntry'],
    });

    expect(sourceIdsOf(dataset, 'OrderItem')).toEqual([ACTIVATED_ITEM]);
    expect(sourceIdsOf(dataset, 'PricebookEntry')).toEqual([]);
    expect(dataset.exclusionCosts).toEqual([
      expect.objectContaining({
        objectApiName: 'OrderItem',
        excludedObject: 'PricebookEntry',
        count: 1,
      }),
      {
        objectApiName: 'Order',
        excludedObject: 'PricebookEntry',
        count: 1,
        note:
          '1 Order record past Draft will be loaded as a draft and stay so: none of its ' +
          'OrderItem records can be loaded without PricebookEntry, which excludedObjects ' +
          'leaves out',
      },
    ]);
  });

  it('reads every item of the orders when the graph holds the items, drafts included', async () => {
    // Discovery reached them: they are the dossier's, whatever the order's
    // status, as they always were.
    const { extractor, sent } = extractorOverOrders(tables());
    const graph = upToTheOrders(makeNode('OrderItem', 2));

    const dataset = await extractFrom(extractor, {
      ...graph,
      edges: [...graph.edges, edge('Order', 'OrderItem', 'OrderItems')],
    });

    expect(sourceIdsOf(dataset, 'OrderItem')).toEqual([ACTIVATED_ITEM, DRAFT_ITEM].sort());
    expect(sent).not.toContain(ORDER_STATUSES);
  });
});

describe('FrozenDatasetExtractor — the parents it fetches by id', () => {
  const OPPORTUNITY = to18('006A00000000opp');

  it('looks for a parent a lookup naming several objects holds in the object its id belongs to', async () => {
    // A feed item's parent can be nearly any object, and each id it held was
    // asked of every one of them: run for real, some fifty queries a pass,
    // all bound to come back empty.
    const QUOTE = to18('0Q0A00000000quo');
    const others = Array.from({ length: 40 }, (_, i) => `Record${String(i).padStart(2, '0')}__c`);
    const parentOf: ScopableField = {
      name: 'Parent__c',
      type: 'reference',
      referenceTo: ['Opportunity', 'Quote', ...others],
      nillable: false,
    };
    // The quote the opportunity names is not in the source any more, so no
    // row the extraction holds tells the prefix of a quote's id.
    const tables: Record<string, FakeRow[]> = {
      Opportunity: [{ Id: OPPORTUNITY, SyncedQuoteId: QUOTE }],
      Note__c: [
        { Id: to18('a01A00000000nt1'), Opportunity__c: OPPORTUNITY, Parent__c: OPPORTUNITY },
        { Id: to18('a01A00000000nt2'), Opportunity__c: OPPORTUNITY, Parent__c: QUOTE },
      ],
    };
    const sent: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        sent.push(soql);
        return soql.includes('FROM RecordType') ? [] : selectRows(tables, soql);
      },
      describeFields: async (objectApiName) => {
        if (objectApiName === 'Opportunity') return [id, lookup('SyncedQuoteId', ['Quote'])];
        if (objectApiName === 'Note__c') {
          return [id, lookup('Opportunity__c', ['Opportunity']), parentOf];
        }
        return [id];
      },
      keyPrefixes: async () =>
        new Map([
          ['Opportunity', '006'],
          ['Quote', '0Q0'],
          ...others.map((name, i): [string, string] => [name, `a${String(i + 10)}`]),
        ]),
    });

    const dataset = await extractor.extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [
          makeNode('Opportunity', 0),
          makeNode('Quote', 1),
          ...others.map((name) => makeNode(name, 1)),
          makeNode('Note__c', 2),
        ],
        [edge('Opportunity', 'Note__c', 'Notes')],
      ),
    });

    expect(sourceIdsOf(dataset, 'Note__c')).toHaveLength(2);
    expect(sent.filter((soql) => /FROM Record\d\d__c /.test(soql))).toEqual([]);
    expect(
      sent.filter((soql) => soql.includes('FROM Opportunity') && soql.includes(QUOTE)),
    ).toEqual([]);
    expect(sent.filter((soql) => soql.includes('FROM Quote') && soql.includes(QUOTE))).toHaveLength(
      2,
    );
  });

  it('fetches the parents of an object hundreds of fields wide in statements that fit', async () => {
    // Two hundred ids a statement, whatever the field list in front of them:
    // past some four hundred fields the statement no longer fits the request
    // URI, the org refuses it, and the whole extraction stops there.
    const lines = Array.from({ length: 300 }, (_, i) => ({
      Id: to18(`00kA${String(i).padStart(11, '0')}`),
      OpportunityId: OPPORTUNITY,
      PricebookEntryId: to18(`01uA${String(i).padStart(11, '0')}`),
    }));
    const tables: Record<string, FakeRow[]> = {
      Opportunity: [{ Id: OPPORTUNITY }],
      OpportunityLineItem: lines,
      PricebookEntry: lines.map((row) => ({ Id: row.PricebookEntryId })),
    };
    const wide = Array.from({ length: 420 }, (_, i) => ({
      name: `Price_Attribute_${String(i).padStart(3, '0')}__c`,
      type: 'string',
      referenceTo: [],
    }));
    const sent: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        sent.push(soql);
        // Salesforce refuses a request URI much past 16 000 characters.
        if (encodeURIComponent(soql).length > 16_000) throw new Error('414 URI Too Long');
        return soql.includes('FROM RecordType') ? [] : selectRows(tables, soql);
      },
      describeFields: async (objectApiName) => {
        if (objectApiName === 'PricebookEntry') return [id, ...wide];
        if (objectApiName === 'OpportunityLineItem') {
          return [
            id,
            lookup('OpportunityId', ['Opportunity'], false),
            lookup('PricebookEntryId', ['PricebookEntry'], false),
          ];
        }
        return [id];
      },
    });

    const dataset = await extractor.extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        // The prices are read before the lines name them: fetched by id after.
        [
          makeNode('Opportunity', 0),
          makeNode('PricebookEntry', 1),
          makeNode('OpportunityLineItem', 1),
        ],
        [edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems')],
      ),
    });

    expect(sourceIdsOf(dataset, 'PricebookEntry')).toHaveLength(300);
    expect(sent.filter((soql) => encodeURIComponent(soql).length > 16_000)).toEqual([]);
  });
});

describe('FrozenDatasetExtractor — the ids a lookup naming several objects holds', () => {
  const OPPORTUNITY = to18('006A00000000opp');
  const QUOTE = to18('0Q0A00000000quo');
  /** A record of the sixth of the forty other objects an email can be related to. */
  const RECORD = to18('a15A00000000rec');
  const others = Array.from({ length: 40 }, (_, i) => `Record${String(i).padStart(2, '0')}__c`);

  /** The extractor, and the statements it sends; with `prefixes`, the org says its key prefixes. */
  function extraction(prefixes: boolean) {
    const tables: Record<string, FakeRow[]> = {
      Opportunity: [{ Id: OPPORTUNITY }],
      Quote: [{ Id: QUOTE, OpportunityId: OPPORTUNITY }],
      EmailMessage: [
        { Id: to18('02sA00000000eml'), Opportunity__c: OPPORTUNITY, RelatedToId: QUOTE },
        { Id: to18('02sA00000000rec'), Opportunity__c: OPPORTUNITY, RelatedToId: RECORD },
      ],
      Record05__c: [{ Id: RECORD }],
    };
    const fields: Record<string, ScopableField[]> = {
      Quote: [id, lookup('OpportunityId', ['Opportunity'])],
      EmailMessage: [
        id,
        lookup('Opportunity__c', ['Opportunity']),
        // What an email is related to: nearly any object, forty of them in the graph.
        lookup('RelatedToId', ['Opportunity', 'Quote', ...others]),
      ],
    };
    const sent: string[] = [];
    const extractor = new FrozenDatasetExtractor({
      query: async (soql) => {
        sent.push(soql);
        return soql.includes('FROM RecordType') ? [] : selectRows(tables, soql);
      },
      describeFields: async (objectApiName) => fields[objectApiName] ?? [id],
      ...(prefixes
        ? {
            keyPrefixes: async () =>
              new Map([
                ['Opportunity', '006'],
                ['Quote', '0Q0'],
                ['EmailMessage', '02s'],
                ...others.map((name, i): [string, string] => [name, `a${String(i + 10)}`]),
              ]),
          }
        : {}),
    });
    return { extractor, sent };
  }

  const options = (): FrozenExtractionOptions => ({
    ...makeOptions(makeTmpDir(), []),
    rootObject: 'Opportunity',
    rootRecordIds: [OPPORTUNITY],
    graph: graphOf(
      [
        makeNode('Opportunity', 0),
        makeNode('Quote', 1),
        makeNode('EmailMessage', 2),
        ...others.map((name) => makeNode(name, 3)),
      ],
      [
        edge('Opportunity', 'Quote', 'Quotes'),
        edge('Opportunity', 'EmailMessage', 'Emails'),
        edge('Quote', 'EmailMessage', 'Emails'),
      ],
    ),
  });
  const askedOfOthers = (sent: string[]): string[] =>
    sent.flatMap((soql) => /FROM (Record\d\d__c) /.exec(soql)?.[1] ?? []);

  it('asks each id of the one object it belongs to', async () => {
    // Put in scope as an id of each object the lookup can name, the quote an
    // email is related to was asked of every one of them the graph held, in
    // forty statements bound to come back empty.
    const { extractor, sent } = extraction(true);

    const dataset = await extractor.extract(options());

    expect(sourceIdsOf(dataset, 'EmailMessage')).toHaveLength(2);
    expect(sourceIdsOf(dataset, 'Record05__c')).toEqual([RECORD]);
    expect(askedOfOthers(sent)).toEqual(['Record05__c']);
  });

  it('places an id by the rows it holds, and one nothing places in each object it can be', async () => {
    // Without the org's prefixes, the quote read before the email says what
    // a quote's id begins with; the other record's prefix nothing says.
    const { extractor, sent } = extraction(false);

    await extractor.extract(options());

    expect(askedOfOthers(sent)).toEqual(others);
    expect(sent.filter((soql) => /FROM Record\d\d__c /.test(soql) && soql.includes(QUOTE))).toEqual(
      [],
    );
  });
});

describe('FrozenDatasetExtractor — a feed item the platform writes itself', () => {
  const OPPORTUNITY = to18('006A00000000opp');
  const POST = to18('0D5A00000000pst');
  const CHANGE = to18('0D5A00000000chg');
  const ON_POST = to18('0D7A00000000onp');
  const ON_CHANGE = to18('0D7A00000000onc');
  const TRACKED = { field: 'Type', value: 'TrackedChange', noun: 'tracked change' };
  const tables = (): Record<string, FakeRow[]> => ({
    Opportunity: [{ Id: OPPORTUNITY }],
    FeedItem: [
      { Id: POST, Type: 'TextPost', ParentId: OPPORTUNITY },
      { Id: CHANGE, Type: 'TrackedChange', ParentId: OPPORTUNITY },
    ],
    FeedComment: [
      { Id: ON_POST, FeedItemId: POST, ParentId: OPPORTUNITY },
      { Id: ON_CHANGE, FeedItemId: CHANGE, ParentId: OPPORTUNITY },
    ],
  });
  // As the org describes them: a comment's feed item may be a feed item or
  // the feed of any object, and may not be left empty; the comment names the
  // record the feed item is on as well.
  const fields: Record<string, ScopableField[]> = {
    FeedItem: [
      id,
      { name: 'Type', type: 'picklist', referenceTo: [] },
      lookup('ParentId', ['Opportunity', 'Order'], false),
    ],
    FeedComment: [
      id,
      lookup('FeedItemId', ['FeedItem', 'OpportunityFeed'], false),
      lookup('ParentId', ['Opportunity', 'Order']),
    ],
  };

  /** An extraction of the opportunity, its feed and the comments on it, read in `order`. */
  async function extractFeed(
    order: string[],
    rows: Record<string, FakeRow[]> = tables(),
  ): Promise<ExtractedDataset> {
    return extractorOver(rows, fields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [makeNode('Opportunity', 0), ...order.map((name) => makeNode(name, 1))],
        [
          edge('Opportunity', 'FeedComment', 'FeedComments'),
          edge('Opportunity', 'FeedItem', 'Feeds'),
          edge('FeedItem', 'FeedComment', 'FeedComments'),
        ],
      ),
    });
  }

  it('leaves out a tracked change and the comment on it, and says so', async () => {
    // Loaded, the platform refuses a tracked change — "Cannot directly insert
    // FeedItem with type TrackedChange" — and the comment on it, which cannot
    // go in without the feed item it answers. The comments are read first,
    // as discovery meets them first under the opportunity: every one of them.
    const dataset = await extractFeed(['FeedComment', 'FeedItem']);

    expect(sourceIdsOf(dataset, 'FeedItem')).toEqual([POST]);
    expect(sourceIdsOf(dataset, 'FeedComment')).toEqual([ON_POST]);
    expect(dataset.leftToThePlatform).toEqual([
      { objectApiName: 'FeedItem', why: { rows: TRACKED }, count: 1 },
      { objectApiName: 'FeedComment', why: { rows: TRACKED, through: 'FeedItemId' }, count: 1 },
    ]);
  });

  it('leaves out a comment on the one feed item of a record, a tracked change, read under the record', async () => {
    // With no feed item of the record in the dataset, nothing holds the
    // comments read under it to the feed items it keeps.
    const onTheChange = (row: FakeRow): boolean =>
      row['Type'] === 'TrackedChange' || row['FeedItemId'] === CHANGE;
    const rows = tables();
    rows['FeedItem'] = rows['FeedItem'].filter(onTheChange);
    rows['FeedComment'] = rows['FeedComment'].filter(onTheChange);

    const dataset = await extractFeed(['FeedItem', 'FeedComment'], rows);

    expect(sourceIdsOf(dataset, 'FeedItem')).toEqual([]);
    expect(sourceIdsOf(dataset, 'FeedComment')).toEqual([]);
    expect(dataset.leftToThePlatform).toEqual([
      { objectApiName: 'FeedItem', why: { rows: TRACKED }, count: 1 },
      { objectApiName: 'FeedComment', why: { rows: TRACKED, through: 'FeedItemId' }, count: 1 },
    ]);
  });
});

describe('FrozenDatasetExtractor — an email, its task and their relations', () => {
  const OPPORTUNITY = to18('006A00000000opp');
  const TASK = to18('00TA00000000tsk');
  const EMAIL = to18('02sA00000000eml');
  const TO_WHAT = to18('0RTA00000000wht');
  const FROM = to18('0CZA00000000frm');
  const TO = to18('0CZA00000000too');
  const tables = (): Record<string, FakeRow[]> => ({
    Opportunity: [{ Id: OPPORTUNITY }],
    Task: [{ Id: TASK, TaskSubtype: 'Email', WhatId: OPPORTUNITY }],
    EmailMessage: [{ Id: EMAIL, RelatedToId: OPPORTUNITY, ActivityId: TASK }],
    TaskRelation: [{ Id: TO_WHAT, TaskId: TASK, RelationId: OPPORTUNITY, IsWhat: true }],
    EmailMessageRelation: [
      { Id: FROM, EmailMessageId: EMAIL, RelationType: 'FromAddress' },
      { Id: TO, EmailMessageId: EMAIL, RelationType: 'ToAddress' },
    ],
  });
  const fields: Record<string, ScopableField[]> = {
    Task: [
      id,
      { name: 'TaskSubtype', type: 'picklist', referenceTo: [] },
      lookup('WhatId', ['Opportunity', 'Quote']),
    ],
    EmailMessage: [
      id,
      lookup('RelatedToId', ['Opportunity', 'Quote']),
      lookup('ActivityId', ['Task']),
    ],
    TaskRelation: [
      id,
      lookup('TaskId', ['Task'], false),
      lookup('RelationId', ['Opportunity', 'Contact'], false),
      { name: 'IsWhat', type: 'boolean', referenceTo: [] },
    ],
    EmailMessageRelation: [
      id,
      lookup('EmailMessageId', ['EmailMessage'], false),
      { name: 'RelationType', type: 'picklist', referenceTo: [] },
    ],
  };

  it('keeps the email and its task, and leaves their relations to the platform, and says so', async () => {
    // Loaded, a relation to the task's what without IsWhat, and the email's
    // relations without their addresses, were refused: the platform writes
    // both itself, from the task's WhatId and from the email's addresses.
    const dataset = await extractorOver(tables(), fields).extract({
      ...makeOptions(makeTmpDir(), []),
      rootObject: 'Opportunity',
      rootRecordIds: [OPPORTUNITY],
      graph: graphOf(
        [
          makeNode('Opportunity', 0),
          makeNode('Task', 1),
          makeNode('EmailMessage', 1),
          makeNode('TaskRelation', 2),
          makeNode('EmailMessageRelation', 2),
        ],
        [
          edge('Opportunity', 'Task', 'Tasks'),
          edge('Opportunity', 'EmailMessage', 'Emails'),
          edge('Task', 'TaskRelation', 'TaskRelations'),
          edge('EmailMessage', 'EmailMessageRelation', 'EmailMessageRelations'),
        ],
      ),
    });

    expect(sourceIdsOf(dataset, 'Task')).toEqual([TASK]);
    expect(sourceIdsOf(dataset, 'EmailMessage')).toEqual([EMAIL]);
    expect(sourceIdsOf(dataset, 'TaskRelation')).toEqual([]);
    expect(sourceIdsOf(dataset, 'EmailMessageRelation')).toEqual([]);
    expect(
      dataset.leftToThePlatform?.map(({ objectApiName, why, count }) => [
        objectApiName,
        why.rows.noun,
        count,
      ]),
    ).toEqual([
      ['TaskRelation', 'what relation', 1],
      ['EmailMessageRelation', 'email relation', 2],
    ]);
  });
});
