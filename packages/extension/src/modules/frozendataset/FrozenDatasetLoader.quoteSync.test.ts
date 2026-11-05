import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { SasReferenceIdMappingStore } from './SasReferenceIdMappingStore.js';
import { FrozenDatasetLoader, type FrozenDatasetLoaderDeps } from './FrozenDatasetLoader.js';
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
 */
function quoteSyncOrg() {
  const held = new Map<string, Row[]>();
  const deleted: Row[] = [];
  let counter = 0;
  const idFor = (objectApiName: string): string =>
    `${PREFIX[objectApiName] ?? '0XX'}xx${String(++counter).padStart(10, '0')}AAA`;
  const rowsOf = (objectApiName: string): Row[] => {
    const rows = held.get(objectApiName) ?? [];
    held.set(objectApiName, rows);
    return rows;
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
      field({ name: 'Name', nillable: false }),
      field({ name: 'StageName', type: 'picklist', nillable: false }),
      field({ name: 'CloseDate', type: 'date', nillable: false }),
      field({ name: 'SyncedQuoteId', type: 'reference', referenceTo: ['Quote'] }),
    ],
  },
  Quote: {
    name: 'Quote',
    fields: [
      field({ name: 'Name', nillable: false }),
      field({
        name: 'OpportunityId',
        type: 'reference',
        referenceTo: ['Opportunity'],
        nillable: false,
      }),
    ],
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
): FrozenDatasetLoaderDeps & { sasDir: string } {
  const sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-quote-sync-'));
  tmpDirs.push(sasDir);
  return {
    orgAccess: {
      query: vi.fn(async () => []),
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
