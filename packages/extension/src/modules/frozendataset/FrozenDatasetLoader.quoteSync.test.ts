import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { SasReferenceIdMappingStore } from './SasReferenceIdMappingStore.js';
import {
  FrozenDatasetLoader,
  ReloadTakesAlongError,
  type FrozenDatasetLoaderDeps,
} from './FrozenDatasetLoader.js';
import type { FrozenDataset } from './types.js';
import type {
  FrozenDmlWriter,
  FrozenLoadConfig,
  TargetFieldDescribe,
  TargetObjectDescribe,
} from './loadTypes.js';

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

const PRODUCT = 'OpportunityLineItem';
const LINE = 'QuoteLineItem';

/** The key prefix of each object's ids, as an org gives them. */
const PREFIX: Readonly<Record<string, string>> = {
  Opportunity: '006',
  Quote: '0Q0',
  [PRODUCT]: '00k',
  [LINE]: '0QL',
};

type Row = Record<string, unknown>;

/**
 * A target in memory that does what a scratch org did as a load set an
 * opportunity's synced quote: syncing a quote makes the opportunity's
 * products the quote's lines, so a product no line of the quote is paired
 * with (`QuoteLineItem.OpportunityLineItemId`) is deleted — the two products
 * of a load that left the quote's lines out were read back `IsDeleted true`,
 * the opportunity's amount 0, while the same load with the lines kept both.
 * And what a scratch org did as a clone wrote products under an opportunity
 * already synced: it copied each onto the quote as a line paired with it.
 * `held` gives it records it holds before the load.
 */
function quoteSyncOrg(held: Record<string, Row[]> = {}) {
  const rows = new Map<string, Row[]>(
    Object.entries(held).map(([objectApiName, list]) => [objectApiName, [...list]]),
  );
  const deleted: Row[] = [];
  let counter = 0;
  const idFor = (objectApiName: string): string =>
    `${PREFIX[objectApiName] ?? '0XX'}xx${String(++counter).padStart(10, '0')}AAA`;
  const rowsOf = (objectApiName: string): Row[] => {
    const list = rows.get(objectApiName) ?? [];
    rows.set(objectApiName, list);
    return list;
  };
  /** The quote an opportunity syncs with, by the opportunity's id. */
  const syncedQuoteOf = (opportunity: unknown): string | undefined => {
    const quote = rowsOf('Opportunity').find((row) => row.Id === opportunity)?.SyncedQuoteId;
    return typeof quote === 'string' ? quote : undefined;
  };
  const sync = (opportunity: string, quote: string): void => {
    const paired = new Set(
      rowsOf(LINE)
        .filter((line) => line.QuoteId === quote)
        .map((line) => line.OpportunityLineItemId),
    );
    const products = rowsOf(PRODUCT);
    for (const product of [...products]) {
      if (product.OpportunityId !== opportunity || paired.has(product.Id)) continue;
      products.splice(products.indexOf(product), 1);
      deleted.push({ ...product, IsDeleted: true });
    }
  };
  const writer: FrozenDmlWriter = {
    insert: vi.fn(async (_org: string, objectApiName: string, records: Row[]) =>
      records.map((record) => {
        const id = idFor(objectApiName);
        rowsOf(objectApiName).push({ ...record, Id: id });
        // A product written under an opportunity already synced: the
        // platform copies it onto the quote as a line paired with it.
        const synced = objectApiName === PRODUCT ? syncedQuoteOf(record.OpportunityId) : undefined;
        if (synced) {
          rowsOf(LINE).push({
            Id: idFor(LINE),
            QuoteId: synced,
            OpportunityLineItemId: id,
            Quantity: record.Quantity,
            UnitPrice: record.UnitPrice,
          });
        }
        return { id, success: true, errors: [] };
      }),
    ),
    update: vi.fn(async (_org: string, objectApiName: string, records: Row[]) =>
      records.map((record) => {
        const row = rowsOf(objectApiName).find((r) => r.Id === record.Id);
        if (!row) return { id: String(record.Id), success: false, errors: ['ENTITY_IS_DELETED'] };
        Object.assign(row, record);
        if (objectApiName === 'Opportunity' && typeof record.SyncedQuoteId === 'string') {
          sync(String(row.Id), record.SyncedQuoteId);
        }
        return { id: String(record.Id), success: true, errors: [] };
      }),
    ),
    delete: vi.fn(async (_org: string, objectApiName: string, ids: string[]) =>
      ids.map((id) => {
        const rows = rowsOf(objectApiName);
        const at = rows.findIndex((r) => r.Id === id);
        if (at >= 0) rows.splice(at, 1);
        return { id, success: true, errors: [] };
      }),
    ),
  };
  return {
    writer,
    rowsOf: (objectApiName: string): Row[] => [...rowsOf(objectApiName)],
    deleted,
  };
}

function field(overrides: Partial<TargetFieldDescribe>): TargetFieldDescribe {
  return {
    name: 'Field__c',
    type: 'string',
    createable: true,
    nillable: true,
    defaultedOnCreate: false,
    ...overrides,
  };
}

const DESCRIBES: Record<string, TargetObjectDescribe> = {
  Opportunity: {
    name: 'Opportunity',
    fields: [
      field({ name: 'Name', nillable: false, nameField: true }),
      field({ name: 'StageName', type: 'picklist', nillable: false }),
      field({ name: 'CloseDate', type: 'date', nillable: false }),
      field({ name: 'SyncedQuoteId', type: 'reference', referenceTo: ['Quote'] }),
    ],
    // As an org lists what goes with an opportunity: its quotes, its products.
    cascadeChildren: [
      { childSObject: 'Quote', field: 'OpportunityId' },
      { childSObject: PRODUCT, field: 'OpportunityId' },
    ],
  },
  Quote: {
    name: 'Quote',
    fields: [
      field({ name: 'Name', nillable: false, nameField: true }),
      field({ name: 'Description', type: 'textarea' }),
      field({
        name: 'OpportunityId',
        type: 'reference',
        referenceTo: ['Opportunity'],
        nillable: false,
      }),
    ],
    cascadeChildren: [{ childSObject: LINE, field: 'QuoteId' }],
  },
  [PRODUCT]: {
    name: PRODUCT,
    fields: [
      field({
        name: 'OpportunityId',
        type: 'reference',
        referenceTo: ['Opportunity'],
        nillable: false,
        updateable: false,
      }),
      field({ name: 'Quantity', type: 'double', nillable: false }),
      field({ name: 'UnitPrice', type: 'currency' }),
    ],
  },
  [LINE]: {
    name: LINE,
    fields: [
      field({
        name: 'QuoteId',
        type: 'reference',
        referenceTo: ['Quote'],
        nillable: false,
        updateable: false,
      }),
      field({ name: 'OpportunityLineItemId', type: 'reference', referenceTo: [PRODUCT] }),
      field({ name: 'Quantity', type: 'double', nillable: false }),
      field({ name: 'UnitPrice', type: 'currency' }),
    ],
  },
};

/**
 * An opportunity of two products and the quote it syncs with, as an
 * extraction freezes it: `SyncedQuoteId` names the quote; with `lines`, the
 * quote's two lines, each paired with its product, as the source holds them.
 */
function dossier(lines: boolean): FrozenDataset {
  const product = (referenceId: string) => ({
    referenceId,
    fields: { OpportunityId: 'O1', Quantity: 1, UnitPrice: 100 },
  });
  return {
    datasetVersion: '1.0.0',
    objects: [
      {
        objectApiName: 'Opportunity',
        records: [
          {
            referenceId: 'O1',
            fields: {
              Name: 'Deal',
              StageName: 'Prospecting',
              CloseDate: '2026-12-01',
              SyncedQuoteId: 'Q1',
            },
          },
        ],
      },
      {
        objectApiName: 'Quote',
        records: [{ referenceId: 'Q1', fields: { Name: 'Quote', OpportunityId: 'O1' } }],
      },
      { objectApiName: PRODUCT, records: [product('P1'), product('P2')] },
      ...(lines
        ? [
            {
              objectApiName: LINE,
              records: ['P1', 'P2'].map((paired, i) => ({
                referenceId: `QL${i + 1}`,
                fields: {
                  QuoteId: 'Q1',
                  OpportunityLineItemId: paired,
                  Quantity: 1,
                  UnitPrice: 100,
                },
              })),
            },
          ]
        : []),
    ],
    recordTypes: {},
    personContactSidecar: [],
  };
}

function depsOf(
  org: ReturnType<typeof quoteSyncOrg>,
  config: FrozenLoadConfig,
  query: (orgId: string, soql: string) => Promise<Row[]> = async () => [],
): FrozenDatasetLoaderDeps & { sasDir: string } {
  const sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-quote-sync-'));
  tmpDirs.push(sasDir);
  return {
    orgAccess: {
      query: vi.fn(query),
      describe: vi.fn(async (_org: string, objectApiName: string) => {
        const describe = DESCRIBES[objectApiName];
        if (!describe) throw new Error(`sObject ${objectApiName} not found`);
        return describe;
      }),
      picklistValues: vi.fn(async () => []),
    },
    writer: org.writer,
    guard: new ProductionGuard(),
    mockDetector: { areCalloutsMocked: vi.fn(async () => true) },
    recordTypeResolver: { resolveByDeveloperName: vi.fn(async () => null) },
    mappingStore: new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }),
    sasGuard: new SasPathGuard(repoRoot),
    config,
    sasDir,
  };
}

describe('a Frozen load of an opportunity that syncs with its quote', () => {
  const linesLeftOut: FrozenLoadConfig = { excludedObjects: [LINE] };

  async function load(dataset: FrozenDataset, config: FrozenLoadConfig) {
    const org = quoteSyncOrg();
    const deps = depsOf(org, config);
    const pass2: string[] = [];
    const report = await new FrozenDatasetLoader(deps).load({
      orgId: '00D-target',
      orgTier: 'development',
      dataset,
      sasDir: deps.sasDir,
      onProgress: (event) => {
        if (event.phase === 'pass2' && event.status !== 'started') pass2.push(event.message);
      },
    });
    return { org, report, pass2 };
  }

  it('keeps the products it wrote when the quote’s lines are left out, the quote not synced, and says so', async () => {
    // Synced in the second pass, the quote with no line made the platform
    // delete both products the load had just written, and the load said
    // "OpportunityLineItem: 2 inserted" and that every record went in.
    const { org, report, pass2 } = await load(dossier(false), linesLeftOut);

    expect(org.deleted).toEqual([]);
    expect(org.rowsOf(PRODUCT)).toHaveLength(2);
    const [opportunity] = org.rowsOf('Opportunity');
    expect(opportunity.SyncedQuoteId).toBeUndefined();
    expect(vi.mocked(org.writer.update).mock.calls).toEqual([]);
    expect(report.quotesLeftUnsynced).toEqual([
      {
        objectApiName: 'Opportunity',
        count: 1,
        note:
          "1 left unsynced with its quote: the load wrote 2 of its products and none of the quote's " +
          'lines, which excludedObjects leaves out — synced, the platform replaces an ' +
          "opportunity's products with its quote's lines; SyncedQuoteId left empty, the products kept",
      },
    ]);
    // Left empty by choice, it is no link the load failed to make.
    expect(report.pass2).toEqual({ resolved: 0, unresolved: [] });
    expect(report.status).toBe('completed');
    expect(pass2).toEqual(['Pass 2: 0 resolved, 0 unresolved, 1 synced quote left unset']);
  });

  it('syncs the quote whose lines it wrote, and keeps the products', async () => {
    const { org, report } = await load(dossier(true), {});

    expect(org.deleted).toEqual([]);
    expect(org.rowsOf(PRODUCT)).toHaveLength(2);
    const [opportunity] = org.rowsOf('Opportunity');
    const [quote] = org.rowsOf('Quote');
    expect(opportunity.SyncedQuoteId).toBe(quote.Id);
    expect(report.pass2).toEqual({ resolved: 1, unresolved: [] });
    expect(report).not.toHaveProperty('quotesLeftUnsynced');
  });

  it('leaves the quote unsynced when the target refused one of its lines', async () => {
    const org = quoteSyncOrg();
    const insert = org.writer.insert;
    org.writer.insert = vi.fn(async (orgId: string, objectApiName: string, records: Row[]) =>
      objectApiName === LINE
        ? [
            ...(await insert(orgId, objectApiName, records.slice(0, 1))),
            { id: '', success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no discount'] },
          ]
        : insert(orgId, objectApiName, records),
    );
    const deps = depsOf(org, {});
    const report = await new FrozenDatasetLoader(deps).load({
      orgId: '00D-target',
      orgTier: 'development',
      dataset: dossier(true),
      sasDir: deps.sasDir,
    });

    expect(org.deleted).toEqual([]);
    expect(org.rowsOf(PRODUCT)).toHaveLength(2);
    expect(org.rowsOf('Opportunity')[0].SyncedQuoteId).toBeUndefined();
    expect(report.quotesLeftUnsynced?.[0]?.note).toContain(
      "1 left unsynced with its quote: the load wrote 2 of its products and 1 of the quote's lines —",
    );
  });

  it('says in its preview that it would leave the quote unsynced', async () => {
    const org = quoteSyncOrg();
    const deps = depsOf(org, linesLeftOut);

    const plan = await new FrozenDatasetLoader(deps).planLoad({
      orgId: '00D-target',
      orgTier: 'development',
      dataset: dossier(false),
      sasDir: deps.sasDir,
    });

    expect(plan.quotesLeftUnsynced).toEqual([
      expect.objectContaining({
        objectApiName: 'Opportunity',
        count: 1,
        note: expect.stringMatching(
          /^1 would be left unsynced with its quote: the load would write 2 of its products and none of the quote's lines, which excludedObjects leaves out/,
        ),
      }),
    ]);
    expect(vi.mocked(org.writer.insert)).not.toHaveBeenCalled();
  });
});

describe('a Frozen reload of an opportunity whose synced quote the target already holds', () => {
  /** The quote a load before wrote, which the reload finds again by its name. */
  const HELD_QUOTE = '0Q0xx0000000900AAA';

  async function reload(dataset: FrozenDataset, config: FrozenLoadConfig) {
    const org = quoteSyncOrg({ Quote: [{ Id: HELD_QUOTE, Name: 'Quote' }] });
    const deps = depsOf(
      org,
      { ...config, identityKeys: { Quote: ['Name'] } },
      async (_org, soql) =>
        soql.startsWith('SELECT Id, Name FROM Quote') ? [{ Id: HELD_QUOTE, Name: 'Quote' }] : [],
    );
    const report = await new FrozenDatasetLoader(deps).load({
      orgId: '00D-target',
      orgTier: 'development',
      dataset,
      sasDir: deps.sasDir,
      reload: true,
    });
    const sentWith = vi
      .mocked(org.writer.insert)
      .mock.calls.filter(([, objectApiName]) => objectApiName === 'Opportunity')
      .flatMap(([, , records]) => records as Row[]);
    return { org, report, sentWith };
  }

  it('leaves the quote unsynced, as it said, when it writes none of its lines: never at the opportunity’s insert', async () => {
    // Found in the target, the quote had its id when the opportunity went
    // in: SyncedQuoteId went with the insert, past the second pass that
    // leaves it empty, while the report said it was left empty.
    const { org, report, sentWith } = await reload(dossier(false), {
      excludedObjects: [LINE],
    });

    expect(sentWith).toHaveLength(1);
    expect(sentWith[0]).not.toHaveProperty('SyncedQuoteId');
    expect(org.rowsOf('Opportunity')[0].SyncedQuoteId).toBeUndefined();
    expect(org.rowsOf(PRODUCT)).toHaveLength(2);
    expect(org.rowsOf(LINE)).toEqual([]);
    expect(report.quotesLeftUnsynced?.[0]?.note).toContain('SyncedQuoteId left empty');
  });

  it('syncs the quote once its lines are in, leaving it the dataset’s two lines, not four', async () => {
    // Synced as the opportunity went in, before its products, the quote took
    // a copy of each product the platform wrote, then the dataset's two
    // lines: four lines for two products, as a clone met on a scratch org.
    const { org, report, sentWith } = await reload(dossier(true), {});

    expect(sentWith[0]).not.toHaveProperty('SyncedQuoteId');
    expect(org.rowsOf('Opportunity')[0].SyncedQuoteId).toBe(HELD_QUOTE);
    expect(org.rowsOf(LINE)).toHaveLength(2);
    expect(org.rowsOf(PRODUCT)).toHaveLength(2);
    expect(org.deleted).toEqual([]);
    expect(report.pass2).toEqual({ resolved: 1, unresolved: [] });
  });
});

describe('a Frozen reload that finds again by its key the quote a load before wrote under its opportunity', () => {
  /**
   * The target after a load of the dossier, deleting as an org does: an
   * opportunity's quotes and products go with it, a quote's lines with the
   * quote. The reload finds the quote again by its name; nothing finds the
   * opportunity.
   */
  async function loadedOnce() {
    const org = quoteSyncOrg();
    const destroy = org.writer.delete;
    const cascade = async (orgId: string, objectApiName: string, ids: string[]) => {
      const answers = await destroy(orgId, objectApiName, ids);
      const under = (child: string, field: string) =>
        org
          .rowsOf(child)
          .filter((row) => ids.includes(String(row[field])))
          .map((row) => String(row.Id));
      if (objectApiName === 'Opportunity') {
        await cascade(orgId, 'Quote', under('Quote', 'OpportunityId'));
        await destroy(orgId, PRODUCT, under(PRODUCT, 'OpportunityId'));
      }
      if (objectApiName === 'Quote') await destroy(orgId, LINE, under(LINE, 'QuoteId'));
      return answers;
    };
    org.writer.delete = vi.fn(cascade);
    const deps = depsOf(org, { identityKeys: { Quote: ['Name'] } }, async (_org, soql) => {
      if (soql.startsWith('SELECT Id, Name FROM Quote')) {
        return org.rowsOf('Quote').map((row) => ({ Id: row.Id, Name: row.Name }));
      }
      const read = /^SELECT (.+) FROM (\w+) WHERE Id IN \((.*)\)$/.exec(soql);
      if (!read) return [];
      const [, columns, objectApiName, list] = read;
      const wanted = list.split(', ').map((quoted) => quoted.slice(1, -1));
      return org
        .rowsOf(objectApiName)
        .filter((row) => wanted.includes(String(row.Id)))
        .map((row) => Object.fromEntries(columns.split(', ').map((c) => [c, row[c]])));
    });
    const options = {
      orgId: '00D-target',
      orgTier: 'development' as const,
      dataset: dossier(true),
      sasDir: deps.sasDir,
    };
    await new FrozenDatasetLoader(deps).load(options);
    return { org, deps, options };
  }

  it('is refused before anything is written, naming the quote its purge would take along with the opportunity', async () => {
    // Sent as it was, the purge deleted the opportunity the load before
    // wrote, the target took the quote the reload had just found along with
    // it, and the reload wrote two lines under a quote no longer there,
    // synced its new opportunity with it, and said it was complete.
    const { org, deps, options } = await loadedOnce();
    const [quote] = org.rowsOf('Quote');
    const [opportunity] = org.rowsOf('Opportunity');
    const writes = () =>
      [org.writer.insert, org.writer.update, org.writer.delete].reduce(
        (sum, call) => sum + vi.mocked(call).mock.calls.length,
        0,
      );
    const before = writes();

    const outcome = await new FrozenDatasetLoader(deps).load({ ...options, reload: true }).then(
      (report) => report.status,
      (err: unknown) => err,
    );

    expect(org.rowsOf('Quote').map((row) => row.Id)).toEqual([quote.Id]);
    expect(org.rowsOf('Opportunity').map((row) => row.Id)).toEqual([opportunity.Id]);
    expect(writes()).toBe(before);
    expect(outcome).toBeInstanceOf(ReloadTakesAlongError);
    expect((outcome as Error).message).toContain(
      'This reload finds in the target 1 record(s) that its purge would delete along with what ' +
        'the loads before it created — Quote (1, under Opportunity)',
    );
    expect((outcome as Error).message).toContain('Nothing was written.');
  });

  it('is refused the same way by its dry run', async () => {
    const { deps, options } = await loadedOnce();

    await expect(
      new FrozenDatasetLoader(deps).planLoad({ ...options, reload: true }),
    ).rejects.toBeInstanceOf(ReloadTakesAlongError);
  });
});

describe('a Frozen reload keyed on a field the rules cleared and a default fills', () => {
  /** The dossier as the rules freeze it: each `Object.field` of `cleared` left `''`. */
  function clearedIn(dataset: FrozenDataset, cleared: readonly string[]): FrozenDataset {
    return {
      ...dataset,
      objects: dataset.objects.map((objectData) => ({
        ...objectData,
        records: objectData.records.map((record) => ({
          ...record,
          fields: {
            ...record.fields,
            ...Object.fromEntries(
              cleared
                .filter((key) => key.startsWith(`${objectData.objectApiName}.`))
                .map((key) => [key.slice(objectData.objectApiName.length + 1), '']),
            ),
          },
        })),
      })),
    };
  }

  /**
   * A target that answers what the loader asks as an org does: a read by
   * identity keys — `(Name = 'a') OR (Name = 'b')` — returns the rows holding
   * one of those tuples, never the others; a read by ids, those rows.
   */
  function answering(org: ReturnType<typeof quoteSyncOrg>, asked: string[]) {
    return async (_org: string, soql: string): Promise<Row[]> => {
      asked.push(soql);
      const pick = (row: Row, columns: string): Row =>
        Object.fromEntries(columns.split(', ').map((c) => [c, row[c]]));
      const byIds = /^SELECT (.+) FROM (\w+) WHERE Id IN \((.*)\)$/.exec(soql);
      if (byIds) {
        const [, columns, objectApiName, list] = byIds;
        const wanted = list.split(', ').map((quoted) => quoted.slice(1, -1));
        return org
          .rowsOf(objectApiName)
          .filter((row) => wanted.includes(String(row.Id)))
          .map((row) => pick(row, columns));
      }
      const byKeys = /^SELECT (Id(?:, \w+)+) FROM (\w+) WHERE \((.+)\)$/.exec(soql);
      if (!byKeys) return [];
      const [, columns, objectApiName, where] = byKeys;
      const tuples = where.split(') OR (').map((tuple) =>
        tuple.split(' AND ').map((condition) => {
          const [, fieldName, value] = /^(\w+) = '(.*)'$/.exec(condition) ?? [];
          return [fieldName, value] as const;
        }),
      );
      return org
        .rowsOf(objectApiName)
        .filter((row) => tuples.some((tuple) => tuple.every(([f, v]) => row[f] === v)))
        .map((row) => pick(row, columns));
    };
  }

  /**
   * The target after a load of the dossier whose quote's name the rules
   * cleared — `Quote.Name = ""` in the dataset — and the declared default
   * filled, deleting as an org does: an opportunity's quotes and products
   * go with it.
   */
  async function loadedOnce(config: FrozenLoadConfig, cleared: readonly string[]) {
    const org = quoteSyncOrg();
    const destroy = org.writer.delete;
    const cascade = async (orgId: string, objectApiName: string, ids: string[]) => {
      const answers = await destroy(orgId, objectApiName, ids);
      const under = (child: string, fieldName: string) =>
        org
          .rowsOf(child)
          .filter((row) => ids.includes(String(row[fieldName])))
          .map((row) => String(row.Id));
      if (objectApiName === 'Opportunity') {
        await cascade(orgId, 'Quote', under('Quote', 'OpportunityId'));
        await destroy(orgId, PRODUCT, under(PRODUCT, 'OpportunityId'));
      }
      return answers;
    };
    org.writer.delete = vi.fn(cascade);
    const asked: string[] = [];
    const deps = depsOf(
      org,
      {
        excludedObjects: [LINE],
        requiredFieldDefaults: {
          'Quote.Name': 'Frozen Quote',
          'Opportunity.Name': 'Frozen Opportunity',
        },
        ...config,
      },
      answering(org, asked),
    );
    const options = {
      orgId: '00D-target',
      orgTier: 'development' as const,
      dataset: clearedIn(dossier(false), cleared),
      sasDir: deps.sasDir,
    };
    await new FrozenDatasetLoader(deps).load(options);
    const writes = () =>
      [org.writer.insert, org.writer.update, org.writer.delete].reduce(
        (sum, call) => sum + vi.mocked(call).mock.calls.length,
        0,
      );
    return { org, deps, options, asked, writes };
  }

  it('finds the quote and the opportunity a load before wrote under their default names, and writes neither again', async () => {
    // Keyed on the names the rules cleared, the reload asked the target for
    // no record: run on a scratch org, its dry run said "Quote: 1 to insert,
    // 1 to purge of 1" of the quote an earlier load wrote under the name the
    // declared default gives it on every load, its rank appended.
    const { org, deps, options } = await loadedOnce(
      { identityKeys: { Opportunity: ['Name'], Quote: ['Name'] } },
      ['Opportunity.Name', 'Quote.Name'],
    );
    const [quote] = org.rowsOf('Quote');
    const [opportunity] = org.rowsOf('Opportunity');
    expect(quote.Name).toBe('Frozen Quote 1');
    expect(opportunity.Name).toBe('Frozen Opportunity 1');

    const plan = await new FrozenDatasetLoader(deps).planLoad({ ...options, reload: true });

    const line = (objectApiName: string) =>
      plan.perObject.find((o) => o.objectApiName === objectApiName);
    expect(line('Quote')).toMatchObject({ toInsert: 0, reusedByKeys: 1, toPurge: 0 });
    expect(line('Opportunity')).toMatchObject({ toInsert: 0, reusedByKeys: 1, toPurge: 0 });
    expect(plan).not.toHaveProperty('keysLeftEmpty');

    vi.mocked(org.writer.insert).mockClear();
    const report = await new FrozenDatasetLoader(deps).load({ ...options, reload: true });

    const inserted = vi
      .mocked(org.writer.insert)
      .mock.calls.map(([, objectApiName]) => objectApiName);
    expect(inserted).not.toContain('Quote');
    expect(inserted).not.toContain('Opportunity');
    expect(org.rowsOf('Quote').map((row) => row.Id)).toEqual([quote.Id]);
    expect(org.rowsOf('Opportunity').map((row) => row.Id)).toEqual([opportunity.Id]);
    expect(report.perObject.find((o) => o.objectApiName === 'Quote')).toMatchObject({
      inserted: 0,
      reused: 1,
    });
  });

  it('is refused before anything is written when the quote it finds by its default name hangs from the opportunity its purge deletes', async () => {
    // Not found, the quote was counted to purge with its opportunity and
    // the refusal of a purge that takes a found record along never saw it.
    const { org, deps, options, writes } = await loadedOnce({ identityKeys: { Quote: ['Name'] } }, [
      'Opportunity.Name',
      'Quote.Name',
    ]);
    const [quote] = org.rowsOf('Quote');
    const before = writes();

    await expect(
      new FrozenDatasetLoader(deps).planLoad({ ...options, reload: true }),
    ).rejects.toBeInstanceOf(ReloadTakesAlongError);
    const outcome = await new FrozenDatasetLoader(deps).load({ ...options, reload: true }).then(
      (report) => report.status,
      (err: unknown) => err,
    );

    expect(outcome).toBeInstanceOf(ReloadTakesAlongError);
    expect((outcome as Error).message).toContain(
      'This reload finds in the target 1 record(s) that its purge would delete along with what ' +
        'the loads before it created — Quote (1, under Opportunity)',
    );
    expect(writes()).toBe(before);
    expect(org.rowsOf('Quote').map((row) => row.Id)).toEqual([quote.Id]);
  });

  it('says, in its dry run and its report, the records whose key stays empty, and asks the target nothing of them', async () => {
    // A field no default fills — not required — stays empty in what the load
    // writes: such a key is no key, and the record goes in unmatched.
    const { org, deps, options, asked } = await loadedOnce(
      { identityKeys: { Quote: ['Description'] } },
      ['Quote.Description'],
    );
    asked.length = 0;

    const plan = await new FrozenDatasetLoader(deps).planLoad({ ...options, reload: true });
    const report = await new FrozenDatasetLoader(deps).load({ ...options, reload: true });

    expect(plan.keysLeftEmpty).toEqual([
      {
        objectApiName: 'Quote',
        fields: ['Description'],
        count: 1,
        note:
          '1 not looked up by its identity keys: Description stays empty in what the load would ' +
          'write — the dataset holds no value, and no default fills it — so it would be inserted, ' +
          'never matched',
      },
    ]);
    expect(report.keysLeftEmpty).toEqual([
      {
        objectApiName: 'Quote',
        fields: ['Description'],
        count: 1,
        note:
          '1 not looked up by its identity keys: Description stayed empty in what the load wrote ' +
          '— the dataset holds no value, and no default fills it — so it was sent to be inserted, ' +
          'never matched',
      },
    ]);
    expect(asked.filter((soql) => / FROM Quote WHERE \(/.test(soql))).toEqual([]);
    expect(org.rowsOf('Quote')).toHaveLength(1);
  });
});
