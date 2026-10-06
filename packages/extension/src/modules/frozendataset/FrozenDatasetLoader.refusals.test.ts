import type { Connection } from 'jsforce';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProductionGuard, type OperationRequest } from '../../core/precheck/ProductionGuard.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import type { SaveErrorDetail } from '../../core/common/existingRecordMatch.js';
import { BulkDataWriter } from '../sync/BulkDataWriter.js';
import type { OperationOutcome } from '../sync/DataSync.js';
import { createBulkDmlWriter } from './BulkDmlWriterAdapter.js';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { SasReferenceIdMappingStore } from './SasReferenceIdMappingStore.js';
import { readCountingContract } from './CountingContract.js';
import {
  FrozenDatasetLoader,
  FrozenLoadCancelledError,
  FrozenLoadFailedError,
  type FrozenDatasetLoaderDeps,
  type FrozenLoadOptions,
} from './FrozenDatasetLoader.js';
import type { FrozenDataset } from './types.js';
import type {
  FrozenDmlWriter,
  FrozenLoadConfig,
  FrozenLoadProgressEvent,
  TargetFieldDescribe,
  TargetObjectDescribe,
} from './loadTypes.js';

/*
 * A record the target refuses on fields it names — a validation rule of its
 * own, or a restricted picklist refusing the record's value — is written
 * again once without them, as Forge writes one. A real trial showed why the
 * picklist matters: a record type never given values of a restricted picklist
 * takes none of them, while the UI API the alignment reads answers the field's
 * whole value set for it, so nothing before the write catches it. Refused, the
 * record failed, and what hung from it with it.
 */

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

/** One call the load made to the target: what it inserted, and of which object. */
interface Sent {
  objectApiName: string;
  rows: Array<Record<string, unknown>>;
}

/** Key prefixes of the ids the target answers with. */
const PREFIX: Record<string, string> = {
  Account: '001',
  Contact: '003',
  PricebookEntry: '01u',
  Pricebook2: '01s',
  Product2: '01t',
};

/** The record type the dataset's accounts go in with, as the target resolves it. */
const RECORD_TYPE_ID = '012000000000001';

/** A restricted picklist refusing `value` of `field`, as the platform words it. */
const picklistRefusal = (value: string, field = 'Tier__c'): SaveErrorDetail => ({
  statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
  message: `bad value for restricted picklist field: ${value}`,
  fields: [field],
});

/** A validation rule refusing the record on `field`. */
const ruleRefusal = (field: string, message = 'Phone must be written +33…'): SaveErrorDetail => ({
  statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  message,
  fields: [field],
});

/** What a refusal's first error reads as, in the outcome's `errors`. */
const asText = (detail: SaveErrorDetail): string =>
  `${detail.statusCode}: ${detail.message} [${detail.fields.join(', ')}]`;

/**
 * A target taking every record but those `refuses` answers errors for, as the
 * load's writer hands them on: the first error as text, every error with the
 * fields it named. Its ids are numbered in the order it takes records.
 */
function targetWriter(
  sent: Sent[],
  refuses: (objectApiName: string, row: Record<string, unknown>) => SaveErrorDetail[] | undefined,
): FrozenDmlWriter {
  let counter = 0;
  return {
    insert: vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        sent.push({ objectApiName, rows: records.map((r) => ({ ...r })) });
        return records.map((row): OperationOutcome => {
          const refused = refuses(objectApiName, row);
          if (refused) {
            return { success: false, errors: [asText(refused[0])], errorDetails: refused };
          }
          return {
            id: `${PREFIX[objectApiName] ?? 'a00'}${String(++counter).padStart(12, '0')}`,
            success: true,
            errors: [],
          };
        });
      },
    ),
    update: vi.fn(async (_org: string, _object: string, records: Array<Record<string, unknown>>) =>
      records.map((r) => ({ id: String(r.Id), success: true, errors: [] })),
    ),
    delete: vi.fn(async (_org: string, _object: string, ids: string[]) =>
      ids.map((id) => ({ id, success: true, errors: [] })),
    ),
  };
}

/**
 * A target whose record type for the accounts was never given values of
 * `Tier__c`: it refuses every value of it, which its describe lists as active
 * and its UI API says the record type takes.
 */
const tiersRefused = (objectApiName: string, row: Record<string, unknown>) =>
  objectApiName === 'Account' && typeof row.Tier__c === 'string'
    ? [picklistRefusal(row.Tier__c)]
    : undefined;

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

/** The accounts' restricted picklist: Gold and Silver active, Bronze retired. */
const TIER = field({
  name: 'Tier__c',
  type: 'picklist',
  restrictedPicklist: true,
  picklistValues: [
    { value: 'Gold', active: true },
    { value: 'Silver', active: true },
    { value: 'Bronze', active: false },
  ],
});

/** The target's describe of the accounts and their contacts. */
function describes(): Record<string, TargetObjectDescribe> {
  return {
    Account: {
      name: 'Account',
      fields: [
        field({ name: 'Name', nillable: false }),
        field({ name: 'RecordTypeId', type: 'reference', referenceTo: ['RecordType'] }),
        field({ name: 'Phone', type: 'phone' }),
        TIER,
      ],
    },
    Contact: {
      name: 'Contact',
      fields: [
        field({ name: 'LastName', nillable: false }),
        field({ name: 'AccountId', type: 'reference', referenceTo: ['Account'] }),
      ],
    },
  };
}

/** Two accounts of one record type — the first holding a tier, the second none — and a contact of the first. */
function accounts(tier = 'Gold'): FrozenDataset {
  return {
    datasetVersion: '1.0.0',
    objects: [
      {
        objectApiName: 'Account',
        records: [
          {
            referenceId: 'Account-000001',
            fields: { Name: 'Anon One', RecordTypeId: 'Retail', Tier__c: tier, Phone: '0100' },
          },
          { referenceId: 'Account-000002', fields: { Name: 'Anon Two', RecordTypeId: 'Retail' } },
        ],
      },
      {
        objectApiName: 'Contact',
        records: [
          {
            referenceId: 'Contact-000001',
            fields: { LastName: 'Anon', AccountId: 'Account-000001' },
          },
        ],
      },
    ],
    recordTypes: { Account: [{ name: 'Retail', developerName: 'Retail' }] },
    personContactSidecar: [],
  };
}

interface MakeDepsOptions {
  dataset: FrozenDataset;
  writer: FrozenDmlWriter;
  config?: FrozenLoadConfig;
  guard?: ProductionGuard;
  describes?: Record<string, TargetObjectDescribe>;
  queryImpl?: (orgId: string, soql: string) => Promise<Array<Record<string, unknown>>>;
}

function makeDeps(options: MakeDepsOptions): FrozenDatasetLoaderDeps & { sasDir: string } {
  const sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-refusals-test-'));
  tmpDirs.push(sasDir);
  const all = options.describes ?? describes();
  return {
    orgAccess: {
      query: vi.fn(options.queryImpl ?? (async () => [])),
      describe: vi.fn(async (_org: string, objectApiName: string) => {
        const describe = all[objectApiName];
        if (!describe) throw new Error(`sObject ${objectApiName} not found`);
        return describe;
      }),
      // The UI API answers the field's whole value set for the record type,
      // which takes none of them.
      picklistValues: vi.fn(async () => ['Gold', 'Silver']),
    },
    writer: options.writer,
    guard: options.guard ?? new ProductionGuard(),
    mockDetector: { areCalloutsMocked: vi.fn(async () => true) },
    recordTypeResolver: { resolveByDeveloperName: vi.fn(async () => RECORD_TYPE_ID) },
    mappingStore: new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }),
    config: options.config,
    sasGuard: new SasPathGuard(repoRoot),
    sasDir,
  };
}

function makeOptions(
  deps: FrozenDatasetLoaderDeps & { sasDir: string },
  dataset: FrozenDataset,
  overrides?: Partial<FrozenLoadOptions>,
): FrozenLoadOptions {
  return {
    orgId: '00D-target',
    orgTier: 'development',
    dataset,
    sasDir: deps.sasDir,
    ...overrides,
  };
}

/** The rows of each call that inserted `objectApiName`, in order. */
const callsOf = (sent: readonly Sent[], objectApiName: string) =>
  sent.filter((call) => call.objectApiName === objectApiName).map((call) => call.rows);

/** The lines that end `objectApiName`, as the load said them. */
const endsOf = (progress: readonly FrozenLoadProgressEvent[], objectApiName: string) =>
  progress
    .filter((e) => e.objectName === objectApiName && e.status !== 'started')
    .map((e) => [e.status, e.message]);

/** What a load ended with, thrown or returned. */
const failureOf = (load: Promise<unknown>): Promise<unknown> => load.catch((e: unknown) => e);

const GOLD_REFUSED =
  'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Gold';

/**
 * A product priced in the standard book and in a custom one, a price per
 * entry of `custom` — and the target's describe of each object, every field
 * createable — with a standard price book the target holds.
 */
function prices(
  standard: number,
  custom: number[],
): { dataset: FrozenDataset; describes: Record<string, TargetObjectDescribe> } {
  const entry = (n: number, book: string, unitPrice: number) => ({
    referenceId: `PricebookEntry-00000${n}`,
    fields: { Pricebook2Id: book, Product2Id: 'Product2-000001', UnitPrice: unitPrice },
  });
  const dataset: FrozenDataset = {
    datasetVersion: '1.0.0',
    objects: [
      {
        objectApiName: 'Pricebook2',
        records: [
          { referenceId: 'Pricebook2-000001', fields: { Name: 'Resellers' } },
          { referenceId: 'Pricebook2-000002', fields: { Name: 'Standard' } },
        ],
      },
      {
        objectApiName: 'Product2',
        records: [{ referenceId: 'Product2-000001', fields: { Name: 'A' } }],
      },
      {
        objectApiName: 'PricebookEntry',
        records: [
          entry(1, 'Pricebook2-000002', standard),
          ...custom.map((unitPrice, i) => entry(i + 2, 'Pricebook2-000001', unitPrice)),
        ],
      },
    ],
    recordTypes: {},
    personContactSidecar: [],
    standardPricebook: 'Pricebook2-000002',
  };
  return {
    dataset,
    describes: Object.fromEntries(
      dataset.objects.map((o) => [
        o.objectApiName,
        {
          name: o.objectApiName,
          fields: [...new Set(o.records.flatMap((r) => Object.keys(r.fields)))].map((name) =>
            field({ name }),
          ),
        },
      ]),
    ),
  };
}

/** The target's standard price book, as the load looks it up. */
const standardBook = async (_org: string, soql: string) =>
  soql.includes('IsStandard = true') ? [{ Id: '01s000000000STD' }] : [];

/** A rule refusing a price of nothing on its unit price. */
const nilPriceRefused = (objectApiName: string, row: Record<string, unknown>) =>
  objectApiName === 'PricebookEntry' && row.UnitPrice === 0
    ? [ruleRefusal('UnitPrice', 'A price cannot be nil')]
    : undefined;

const NIL_PRICE_REFUSED = 'FIELD_CUSTOM_VALIDATION_EXCEPTION: A price cannot be nil';

describe('FrozenDatasetLoader — a record the target refused on fields it named', () => {
  it('writes again without its field a record a restricted picklist refused the value of, and its contact names it', async () => {
    const dataset = accounts();
    const sent: Sent[] = [];
    const progress: FrozenLoadProgressEvent[] = [];
    const deps = makeDeps({ dataset, writer: targetWriter(sent, tiersRefused) });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
    );

    expect(callsOf(sent, 'Account')).toEqual([
      [
        { Name: 'Anon One', RecordTypeId: RECORD_TYPE_ID, Tier__c: 'Gold', Phone: '0100' },
        { Name: 'Anon Two', RecordTypeId: RECORD_TYPE_ID },
      ],
      [{ Name: 'Anon One', RecordTypeId: RECORD_TYPE_ID, Phone: '0100' }],
    ]);
    // In the target, the account its contact hangs from: written against it.
    expect(callsOf(sent, 'Contact')).toEqual([
      [{ LastName: 'Anon', AccountId: '001000000000002' }],
    ]);
    expect(report.status).toBe('completed');
    expect(report.perObject.find((o) => o.objectApiName === 'Account')).toEqual({
      objectApiName: 'Account',
      fromFiles: 2,
      inserted: 2,
      reused: 0,
      skippedDuplicates: [],
      failed: [],
      writtenWithoutFields: {
        rows: 1,
        fields: [
          { field: 'Tier__c', refusedBy: 'restricted-picklist', reason: GOLD_REFUSED, rows: 1 },
        ],
      },
    });
    expect(endsOf(progress, 'Account')).toEqual([
      [
        'done',
        'Account: 2 inserted, 0 reused, 0 duplicates skipped, 0 failed, 1 written without ' +
          `Tier__c: a restricted picklist of the target refused its value, ${GOLD_REFUSED}`,
      ],
    ]);
    // Mapped and created by the load, as any record it inserted: a removal
    // takes it, a reload finds it.
    const store = new SasReferenceIdMappingStore(deps.sasDir, {
      guard: new SasPathGuard(repoRoot),
    });
    expect((await store.load()).get('Account-000001')).toBe('001000000000002');
    expect((await store.recordedLoads())[0].created).toContainEqual({
      objectApiName: 'Account',
      referenceIds: ['Account-000002', 'Account-000001'],
    });
    // Expected in the org as any record it inserted, and named under the
    // field it went without, for the verification.
    expect(
      readCountingContract(new SasPathGuard(repoRoot), report.contractPath).objects.Account,
    ).toEqual({
      fromFiles: 2,
      exclusionReasons: {},
      excluded: 0,
      added: 0,
      expected: 2,
      writtenWithout: { Tier__c: ['Account-000001'] },
    });
  });

  it('writes again without its field a record a validation rule refused on it', async () => {
    const dataset = accounts();
    const sent: Sent[] = [];
    const deps = makeDeps({
      dataset,
      writer: targetWriter(sent, (objectApiName, row) =>
        objectApiName === 'Account' && row.Phone !== undefined ? [ruleRefusal('Phone')] : undefined,
      ),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(callsOf(sent, 'Account')[1]).toEqual([
      { Name: 'Anon One', RecordTypeId: RECORD_TYPE_ID, Tier__c: 'Gold' },
    ]);
    expect(report.perObject.find((o) => o.objectApiName === 'Account')).toMatchObject({
      inserted: 2,
      failed: [],
      writtenWithoutFields: {
        rows: 1,
        fields: [
          {
            field: 'Phone',
            refusedBy: 'validation-rule',
            reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33…',
            rows: 1,
          },
        ],
      },
    });
  });

  it('writes the value a declared picklist rule gives in place of the one the target refused', async () => {
    const dataset = accounts();
    const sent: Sent[] = [];
    const progress: FrozenLoadProgressEvent[] = [];
    const deps = makeDeps({
      dataset,
      // This record type takes Silver alone.
      writer: targetWriter(sent, (objectApiName, row) =>
        objectApiName === 'Account' && row.Tier__c === 'Gold'
          ? [picklistRefusal('Gold')]
          : undefined,
      ),
      config: { picklistRules: { 'Account.Tier__c': { action: 'replace', value: 'Silver' } } },
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
    );

    expect(callsOf(sent, 'Account')[1]).toEqual([
      { Name: 'Anon One', RecordTypeId: RECORD_TYPE_ID, Tier__c: 'Silver', Phone: '0100' },
    ]);
    expect(
      report.perObject.find((o) => o.objectApiName === 'Account')?.writtenWithoutFields,
    ).toEqual({
      rows: 1,
      fields: [
        {
          field: 'Tier__c',
          refusedBy: 'restricted-picklist',
          reason: GOLD_REFUSED,
          rows: 1,
          replacedWith: 'Silver',
        },
      ],
    });
    expect(endsOf(progress, 'Account')[0][1]).toBe(
      'Account: 2 inserted, 0 reused, 0 duplicates skipped, 0 failed, 1 written with Tier__c ' +
        `set to "Silver": a restricted picklist of the target refused its value, ${GOLD_REFUSED}`,
    );
    // The field holds a value: nothing for the verification to pass over.
    expect(
      readCountingContract(new SasPathGuard(repoRoot), report.contractPath).objects.Account,
    ).not.toHaveProperty('writtenWithout');
  });

  it('leaves the field out when the declared rule would send again the value the target refused', async () => {
    // The alignment replaced a retired tier by the rule's value, which the
    // record type refuses as it refuses every tier.
    const dataset = accounts('Bronze');
    const sent: Sent[] = [];
    const deps = makeDeps({
      dataset,
      writer: targetWriter(sent, tiersRefused),
      config: { picklistRules: { 'Account.Tier__c': { action: 'replace', value: 'Silver' } } },
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(callsOf(sent, 'Account')).toEqual([
      [
        { Name: 'Anon One', RecordTypeId: RECORD_TYPE_ID, Tier__c: 'Silver', Phone: '0100' },
        { Name: 'Anon Two', RecordTypeId: RECORD_TYPE_ID },
      ],
      [{ Name: 'Anon One', RecordTypeId: RECORD_TYPE_ID, Phone: '0100' }],
    ]);
    expect(report.alignment.adjustments).toEqual([
      expect.objectContaining({ field: 'Tier__c', value: 'Bronze', scope: 'global' }),
    ]);
    expect(report.perObject.find((o) => o.objectApiName === 'Account')).toMatchObject({
      inserted: 2,
      failed: [],
      writtenWithoutFields: { rows: 1, fields: [expect.objectContaining({ field: 'Tier__c' })] },
    });
    expect(
      report.perObject.find((o) => o.objectApiName === 'Account')?.writtenWithoutFields?.fields[0],
    ).not.toHaveProperty('replacedWith');
  });

  it('sends no record again whose refusal holds another error, and lists it as failed', async () => {
    const dataset = accounts();
    const sent: Sent[] = [];
    const deps = makeDeps({
      dataset,
      writer: targetWriter(sent, (objectApiName, row) =>
        objectApiName === 'Account' && row.Tier__c
          ? [
              picklistRefusal('Gold'),
              {
                statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
                message: 'trigger',
                fields: [],
              },
            ]
          : undefined,
      ),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(callsOf(sent, 'Account')).toHaveLength(1);
    expect(report.status).toBe('completed-with-errors');
    expect(report.perObject.find((o) => o.objectApiName === 'Account')).toMatchObject({
      inserted: 1,
      failed: [{ referenceId: 'Account-000001', errors: [`${GOLD_REFUSED} [Tier__c]`] }],
    });
    expect(
      report.perObject.find((o) => o.objectApiName === 'Account')?.writtenWithoutFields,
    ).toBeUndefined();
  });

  it('lists as failed, with both refusals, a record the target refused again, and sends it no third time', async () => {
    const dataset = accounts();
    const sent: Sent[] = [];
    const deps = makeDeps({
      dataset,
      // The picklist is checked before the rules run: the rule's refusal
      // comes once the tier is gone.
      writer: targetWriter(sent, (objectApiName, row) => {
        if (objectApiName !== 'Account' || row.Name !== 'Anon One') return undefined;
        return row.Tier__c ? [picklistRefusal('Gold')] : [ruleRefusal('Phone')];
      }),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(callsOf(sent, 'Account')).toHaveLength(2);
    expect(report.status).toBe('completed-with-errors');
    expect(report.perObject.find((o) => o.objectApiName === 'Account')?.failed).toEqual([
      {
        objectApiName: 'Account',
        referenceId: 'Account-000001',
        errors: [
          'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33… [Phone]',
          `Sent again without Tier__c after the first refusal: ${GOLD_REFUSED} [Tier__c]`,
        ],
      },
    ]);
    expect(
      readCountingContract(new SasPathGuard(repoRoot), report.contractPath).objects.Account,
    ).toMatchObject({ expected: 1, exclusionReasons: { 'dml-failed': 1 } });
  });

  it('skips and lists a record the target refused again as a duplicate', async () => {
    const dataset = accounts();
    const sent: Sent[] = [];
    const deps = makeDeps({
      dataset,
      writer: targetWriter(sent, (objectApiName, row) => {
        if (objectApiName !== 'Account' || row.Name !== 'Anon One') return undefined;
        return row.Tier__c
          ? [picklistRefusal('Gold')]
          : [
              {
                statusCode: 'DUPLICATES_DETECTED',
                message: 'Use one of these records?',
                fields: [],
              },
            ];
      }),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(report.perObject.find((o) => o.objectApiName === 'Account')).toMatchObject({
      inserted: 1,
      failed: [],
      skippedDuplicates: [
        {
          referenceId: 'Account-000001',
          errors: [
            'DUPLICATES_DETECTED: Use one of these records? []',
            `Sent again without Tier__c after the first refusal: ${GOLD_REFUSED} [Tier__c]`,
          ],
        },
      ],
    });
  });

  it('carries the fields a refusal named through the writer a load writes with', async () => {
    // The writer kept the first error's text alone, its fields only as words
    // in it: no record was ever written again.
    const dataset = accounts();
    const sent: Sent[] = [];
    let counter = 0;
    const sobject = (objectApiName: string) => ({
      create: async (rows: Array<Record<string, unknown>>) => {
        sent.push({ objectApiName, rows: rows.map((r) => ({ ...r })) });
        return rows.map((row) =>
          objectApiName === 'Account' && row.Tier__c
            ? {
                success: false,
                errors: [
                  {
                    statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
                    message: `bad value for restricted picklist field: ${String(row.Tier__c)}`,
                    fields: ['Tier__c'],
                  },
                ],
              }
            : {
                success: true,
                id: `${PREFIX[objectApiName]}${String(++counter).padStart(12, '0')}`,
              },
        );
      },
    });
    const writer = createBulkDmlWriter(
      new BulkDataWriter({
        connection: { sobject } as unknown as Connection,
        bulkExecutor: new BulkApiExecutor(200),
        bulkManager: new BulkApiManager(),
        retryConfig: { maxRetries: 0, initialDelay: 0, jitter: false },
        onProgress: () => undefined,
        log: () => undefined,
      }),
    );
    const deps = makeDeps({ dataset, writer });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(callsOf(sent, 'Account')[1]).toEqual([
      { Name: 'Anon One', RecordTypeId: RECORD_TYPE_ID, Phone: '0100' },
    ]);
    expect(report.status).toBe('completed');
    expect(report.perObject.find((o) => o.objectApiName === 'Account')).toMatchObject({
      inserted: 2,
      failed: [],
      writtenWithoutFields: { rows: 1 },
    });
  });

  describe('when the write sending it again does not go through', () => {
    /** Production Guard refusing the second insert of the accounts alone. */
    function guardRefusingTheSecondAccountWrite(): ProductionGuard {
      const guard = new ProductionGuard();
      const judge = guard.check.bind(guard);
      let accountWrites = 0;
      vi.spyOn(guard, 'check').mockImplementation((request: OperationRequest) =>
        request.objectName === 'Account' && ++accountWrites === 2
          ? {
              allowed: false,
              requiresConfirmation: false,
              blockedReason: 'not on this org',
              warnings: [],
              impactSummary: '',
            }
          : judge(request),
      );
      return guard;
    }

    it('fails the load on a Production Guard refusal, counting what the first write put in and the record refused', async () => {
      const dataset = accounts();
      const sent: Sent[] = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const deps = makeDeps({
        dataset,
        writer: targetWriter(sent, tiersRefused),
        guard: guardRefusingTheSecondAccountWrite(),
      });

      const error = await failureOf(
        new FrozenDatasetLoader(deps).load(
          makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
        ),
      );

      expect(error).toBeInstanceOf(FrozenLoadFailedError);
      expect(callsOf(sent, 'Account')).toHaveLength(1);
      expect(callsOf(sent, 'Contact')).toEqual([]);
      const why = 'Production guard refused insert on Account: not on this org';
      expect((error as FrozenLoadFailedError).written.perObject).toEqual([
        {
          objectApiName: 'Account',
          fromFiles: 2,
          inserted: 1,
          reused: 0,
          skippedDuplicates: [],
          failed: [
            {
              objectApiName: 'Account',
              referenceId: 'Account-000001',
              errors: [`${GOLD_REFUSED} [Tier__c]`, `Not written again without Tier__c: ${why}`],
            },
          ],
        },
      ]);
      expect(endsOf(progress, 'Account')).toEqual([
        ['error', `Account: 1 inserted, 0 reused, 0 duplicates skipped, 1 failed — ${why}`],
      ]);
      // What it created is named for a removal.
      const store = new SasReferenceIdMappingStore(deps.sasDir, {
        guard: new SasPathGuard(repoRoot),
      });
      expect((await store.recordedLoads())[0].created).toEqual([
        { objectApiName: 'Account', referenceIds: ['Account-000002'] },
      ]);
    });

    it('sends no record again after a cancel that came during the first write, nor asks the guard', async () => {
      const dataset = accounts();
      const sent: Sent[] = [];
      const stop = new AbortController();
      const writer = targetWriter(sent, tiersRefused);
      const insert = writer.insert;
      writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
        if (args[1] === 'Account') stop.abort();
        return insert(...args);
      });
      const guard = new ProductionGuard();
      const check = vi.spyOn(guard, 'check');
      const progress: FrozenLoadProgressEvent[] = [];
      const deps = makeDeps({ dataset, writer, guard });

      const error = await failureOf(
        new FrozenDatasetLoader(deps).load(
          makeOptions(deps, dataset, { signal: stop.signal, onProgress: (e) => progress.push(e) }),
        ),
      );

      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect(callsOf(sent, 'Account')).toHaveLength(1);
      expect(check.mock.calls.filter(([request]) => request.objectName === 'Account')).toHaveLength(
        1,
      );
      expect((error as FrozenLoadCancelledError).written.perObject).toEqual([
        expect.objectContaining({
          objectApiName: 'Account',
          inserted: 1,
          failed: [
            {
              objectApiName: 'Account',
              referenceId: 'Account-000001',
              errors: [
                `${GOLD_REFUSED} [Tier__c]`,
                'Not written again without Tier__c: the load was cancelled first',
              ],
            },
          ],
        }),
      ]);
      expect(endsOf(progress, 'Account')).toEqual([
        ['error', 'Account: 1 inserted, 0 reused, 0 duplicates skipped, 1 failed'],
      ]);
    });

    it('counts the standard prices and the custom ones the first write put in when the write sending one again throws', async () => {
      const { dataset, describes: all } = prices(10, [9, 0]);
      const sent: Sent[] = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const writer = targetWriter(sent, nilPriceRefused);
      const insert = writer.insert;
      let writes = 0;
      writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
        if (args[1] === 'PricebookEntry' && ++writes === 3) {
          throw new Error('UNKNOWN_EXCEPTION: An unexpected error occurred');
        }
        return insert(...args);
      });
      const deps = makeDeps({ dataset, writer, describes: all, queryImpl: standardBook });

      const error = await failureOf(
        new FrozenDatasetLoader(deps).load(
          makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
        ),
      );

      expect(error).toBeInstanceOf(FrozenLoadFailedError);
      const why = 'UNKNOWN_EXCEPTION: An unexpected error occurred';
      expect((error as FrozenLoadFailedError).written.perObject).toContainEqual({
        objectApiName: 'PricebookEntry',
        fromFiles: 3,
        inserted: 2,
        reused: 0,
        skippedDuplicates: [],
        failed: [
          {
            objectApiName: 'PricebookEntry',
            referenceId: 'PricebookEntry-000003',
            errors: [
              `${NIL_PRICE_REFUSED} [UnitPrice]`,
              `Not written again without UnitPrice: ${why}`,
            ],
          },
        ],
      });
      expect(endsOf(progress, 'PricebookEntry')).toEqual([
        ['error', `PricebookEntry: 2 inserted, 0 reused, 0 duplicates skipped, 1 failed — ${why}`],
      ]);
    });

    it('says what the standard prices went in without when the custom ones throw', async () => {
      const { dataset, describes: all } = prices(0, [9]);
      const sent: Sent[] = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const writer = targetWriter(sent, nilPriceRefused);
      const insert = writer.insert;
      let writes = 0;
      writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
        // The standard price, written again without its price, then the custom one.
        if (args[1] === 'PricebookEntry' && ++writes === 3) {
          throw new Error('UNKNOWN_EXCEPTION: An unexpected error occurred');
        }
        return insert(...args);
      });
      const deps = makeDeps({ dataset, writer, describes: all, queryImpl: standardBook });

      const error = await failureOf(
        new FrozenDatasetLoader(deps).load(
          makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
        ),
      );

      expect(error).toBeInstanceOf(FrozenLoadFailedError);
      const writtenWithoutFields = {
        rows: 1,
        fields: [
          { field: 'UnitPrice', refusedBy: 'validation-rule', reason: NIL_PRICE_REFUSED, rows: 1 },
        ],
      };
      expect((error as FrozenLoadFailedError).written.perObject).toContainEqual(
        expect.objectContaining({
          objectApiName: 'PricebookEntry',
          inserted: 1,
          notInserted: 1,
          writtenWithoutFields,
        }),
      );
      expect(endsOf(progress, 'PricebookEntry')).toEqual([
        [
          'error',
          'PricebookEntry: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 1 not inserted: ' +
            'the load failed, 1 written without UnitPrice: a validation rule of the target ' +
            `refused it, ${NIL_PRICE_REFUSED} — UNKNOWN_EXCEPTION: An unexpected error occurred`,
        ],
      ]);
    });
  });

  it('counts together what the standard and the custom prices went in without', async () => {
    const { dataset, describes: all } = prices(0, [0, 9]);
    const sent: Sent[] = [];
    const progress: FrozenLoadProgressEvent[] = [];
    const deps = makeDeps({
      dataset,
      writer: targetWriter(sent, nilPriceRefused),
      describes: all,
      queryImpl: standardBook,
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
    );

    expect(callsOf(sent, 'PricebookEntry')).toHaveLength(4);
    expect(report.perObject.find((o) => o.objectApiName === 'PricebookEntry')).toMatchObject({
      inserted: 3,
      failed: [],
      writtenWithoutFields: {
        rows: 2,
        fields: [
          { field: 'UnitPrice', refusedBy: 'validation-rule', reason: NIL_PRICE_REFUSED, rows: 2 },
        ],
      },
    });
    expect(endsOf(progress, 'PricebookEntry')[0][1]).toBe(
      'PricebookEntry: 3 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 written without ' +
        `UnitPrice: a validation rule of the target refused it, ${NIL_PRICE_REFUSED}`,
    );
    expect(
      readCountingContract(new SasPathGuard(repoRoot), report.contractPath).objects.PricebookEntry
        ?.writtenWithout,
    ).toEqual({ UnitPrice: ['PricebookEntry-000001', 'PricebookEntry-000002'] });
  });

  it('says the value it sent again when the target refused that one too', async () => {
    // A record type that takes none of the field's values refuses the rule's
    // value as it refused the record's own.
    const dataset = accounts();
    const sent: Sent[] = [];
    const deps = makeDeps({
      dataset,
      writer: targetWriter(sent, tiersRefused),
      config: { picklistRules: { 'Account.Tier__c': { action: 'replace', value: 'Silver' } } },
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(callsOf(sent, 'Account')).toHaveLength(2);
    expect(report.perObject.find((o) => o.objectApiName === 'Account')?.failed).toEqual([
      {
        objectApiName: 'Account',
        referenceId: 'Account-000001',
        errors: [
          'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Silver [Tier__c]',
          `Sent again with Tier__c set to "Silver" after the first refusal: ${GOLD_REFUSED} [Tier__c]`,
        ],
      },
    ]);
  });
});
