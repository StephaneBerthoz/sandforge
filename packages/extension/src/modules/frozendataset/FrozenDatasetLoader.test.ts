import type { Connection } from 'jsforce';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProductionGuard, type OperationRequest } from '../../core/precheck/ProductionGuard.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { BulkDataWriter } from '../sync/BulkDataWriter.js';
import { createBulkDmlWriter } from './BulkDmlWriterAdapter.js';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { SasReferenceIdMappingStore } from './SasReferenceIdMappingStore.js';
import { contractCountsLoad, readCountingContract } from './CountingContract.js';
import {
  FrozenDatasetLoader,
  FrozenLoadCancelledError,
  FrozenLoadFailedError,
  LoadConfigError,
  type FrozenDatasetLoaderDeps,
  type FrozenLoadOptions,
} from './FrozenDatasetLoader.js';
import { LoadGuardError } from './LoadGuards.js';
import { loadCreatedRecords, loadToRemove } from './loadRecords.js';
import { standardPriceIds } from '../../core/common/platformRecords.js';
import { removeRunRecords, type RemovalOrg } from '../forge/ForgeRunRemoval.js';
import type { OperationOutcome } from '../sync/DataSync.js';
import type { FrozenDataset } from './types.js';
import type {
  FrozenDmlWriter,
  FrozenLoadConfig,
  FrozenLoadProgressEvent,
  TargetFieldDescribe,
  TargetObjectDescribe,
} from './loadTypes.js';

/**
 * The shared rules of the platform's records, as they are, with the one that
 * tells standard prices apart watched: the purge asks it, not a copy of it.
 */
vi.mock('../../core/common/platformRecords.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/common/platformRecords.js')>();
  return { ...actual, standardPriceIds: vi.fn(actual.standardPriceIds) };
});

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-loader-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

/** DML call log entry, for order and payload assertions. */
interface DmlCall {
  op: 'insert' | 'update' | 'delete';
  objectApiName: string;
  payload: unknown;
}

/** Writer mock: every DML succeeds, real-looking IDs are generated. */
function makeWriter(calls: DmlCall[]): FrozenDmlWriter {
  let counter = 0;
  return {
    insert: vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'insert', objectApiName, payload: records });
        return records.map(() => ({
          id: `REAL-${objectApiName}-${++counter}`,
          success: true,
          errors: [],
        }));
      },
    ),
    update: vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'update', objectApiName, payload: records });
        return records.map((r) => ({ id: String(r.Id), success: true, errors: [] }));
      },
    ),
    delete: vi.fn(async (_org: string, objectApiName: string, recordIds: string[]) => {
      calls.push({ op: 'delete', objectApiName, payload: recordIds });
      return recordIds.map((id) => ({ id, success: true, errors: [] }));
    }),
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

/** Echo describe: every dataset field exists, is createable and nillable. */
function describeFromDataset(
  dataset: FrozenDataset,
  extras?: Record<string, TargetFieldDescribe[]>,
): Record<string, TargetObjectDescribe> {
  const describes: Record<string, TargetObjectDescribe> = {};
  for (const objectData of dataset.objects) {
    const names = new Set<string>();
    for (const record of objectData.records) {
      for (const name of Object.keys(record.fields)) {
        names.add(name);
      }
    }
    describes[objectData.objectApiName] = {
      name: objectData.objectApiName,
      fields: [...names].map((name) => field({ name })),
    };
  }
  for (const [objectApiName, extraFields] of Object.entries(extras ?? {})) {
    describes[objectApiName] = describes[objectApiName] ?? { name: objectApiName, fields: [] };
    describes[objectApiName].fields.push(...extraFields);
  }
  return describes;
}

interface MakeDepsOptions {
  dataset: FrozenDataset;
  describes?: Record<string, TargetObjectDescribe>;
  writer?: FrozenDmlWriter;
  queryImpl?: (orgId: string, soql: string) => Promise<Array<Record<string, unknown>>>;
  config?: FrozenLoadConfig;
  sasDir?: string;
  guard?: ProductionGuard;
  /** The user the session writes as; absent, the target does not say. */
  userId?: string;
}

function makeDeps(options: MakeDepsOptions): FrozenDatasetLoaderDeps & { sasDir: string } {
  const sasDir = options.sasDir ?? makeTmpDir();
  const describes = options.describes ?? describeFromDataset(options.dataset);
  const user = options.userId;
  return {
    orgAccess: {
      query: vi.fn(options.queryImpl ?? (async () => [])),
      describe: vi.fn(async (_org: string, objectApiName: string) => {
        const describe = describes[objectApiName];
        if (!describe) {
          throw new Error(`sObject ${objectApiName} not found`);
        }
        return describe;
      }),
      picklistValues: vi.fn(async () => []),
      ...(user === undefined ? {} : { userId: vi.fn(async () => user) }),
    },
    writer: options.writer ?? makeWriter([]),
    guard: options.guard ?? new ProductionGuard(),
    mockDetector: { areCalloutsMocked: vi.fn(async () => true) },
    recordTypeResolver: { resolveByDeveloperName: vi.fn(async () => '012RT-RESOLVED') },
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

/** Account ← Contact fixture (one account, one contact). */
function makeAccountContactDataset(): FrozenDataset {
  return {
    datasetVersion: '1.0.0',
    objects: [
      {
        objectApiName: 'Account',
        records: [
          {
            referenceId: 'Account-000001',
            fields: { Name: 'Anon Account', ExternalId__c: 'ACC-1' },
          },
        ],
      },
      {
        objectApiName: 'Contact',
        records: [
          {
            referenceId: 'Contact-000001',
            fields: { LastName: 'Doe', AccountId: 'Account-000001', Email: 'a@example.invalid' },
          },
        ],
      },
    ],
    recordTypes: {},
    personContactSidecar: [],
  };
}

describe('FrozenDatasetLoader — guards', () => {
  it('refuses a non-sandbox org before any DML', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    await expect(
      loader.load(makeOptions(deps, dataset, { orgTier: 'production' })),
    ).rejects.toThrow(LoadGuardError);
    expect(calls).toEqual([]);
  });

  it('aborts before any DML when the guard withholds confirmation', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    // The entry guards only let development/scratch through, and those tiers
    // never ask ProductionGuard for a confirmation — so this is defence in
    // depth against a host-injected guard, not a path the stock guard reaches.
    // The check is stubbed to demand the confirmation the user then declines.
    const guard = new ProductionGuard({ requestConfirmation: async () => false });
    vi.spyOn(guard, 'check').mockReturnValue({
      allowed: true,
      requiresConfirmation: true,
      requiresApproval: false,
      warnings: [],
      impactSummary: 'INSERT 1 Account record(s)',
    });
    const deps = makeDeps({ dataset, writer: makeWriter(calls), guard });
    const loader = new FrozenDatasetLoader(deps);

    const error: unknown = await loader.load(makeOptions(deps, dataset)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LoadGuardError);
    expect((error as LoadGuardError).code).toBe('guard-refused');
    // Refusal happens on the FIRST batch: nothing reached the target org.
    expect(calls).toEqual([]);
  });
});

describe('FrozenDatasetLoader — fresh load', () => {
  it('inserts parents before children, substitutes FKs, persists mapping and contract', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const guard = new ProductionGuard();
    const check = vi.spyOn(guard, 'check');
    const deps = makeDeps({ dataset, writer: makeWriter(calls), guard });
    const progress: string[] = [];
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e.phase) }),
    );

    expect(report.status).toBe('completed');
    // Parents (Account) insert before children (Contact).
    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual([
      'insert:Account',
      'insert:Contact',
    ]);
    // The Contact FK carries the REAL Account ID captured at insert.
    const contactPayload = calls[1].payload as Array<Record<string, unknown>>;
    expect(contactPayload[0].AccountId).toBe('REAL-Account-1');
    // referenceId → real ID mapping persisted in the sas.
    const mapping = await new SasReferenceIdMappingStore(deps.sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    expect(mapping.get('Account-000001')).toBe('REAL-Account-1');
    expect(mapping.get('Contact-000001')).toBe('REAL-Contact-2');
    // Counting contract: files minus exclusions.
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Account).toMatchObject({ fromFiles: 1, excluded: 0, expected: 1 });
    expect(contract.objects.Contact).toMatchObject({ fromFiles: 1, excluded: 0, expected: 1 });
    expect(report.mappingPath).toContain('referenceid-mapping.json');
    // The ProductionGuard judges every DML batch of the session —
    // exactly the two inserts of the fixture, no silent extra write.
    expect(check).toHaveBeenCalledTimes(2);
    expect(check.mock.calls[0][0].module).toBe('frozendataset');
    // Progress callbacks for the bridge.
    expect(progress).toContain('guards');
    expect(progress).toContain('insert');
    expect(progress).toContain('done');
  });

  it('removes fields absent from the target and lists them in the report', async () => {
    const dataset = makeAccountContactDataset();
    // Describe echo built BEFORE the ghost field is added: the target does not have it.
    const describes = describeFromDataset(dataset);
    dataset.objects[1].records[0].fields.GhostField__c = 'boo';
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, describes, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(report.alignment.removals).toEqual([
      {
        objectApiName: 'Contact',
        field: 'GhostField__c',
        reason: 'not-in-target',
        affectedRecords: 1,
      },
    ]);
    const contactPayload = calls.find((c) => c.objectApiName === 'Contact')?.payload as Array<
      Record<string, unknown>
    >;
    expect(contactPayload[0]).not.toHaveProperty('GhostField__c');
  });

  it('excludes an object absent from the target org, lists it, and says the load had errors', async () => {
    // Its records are lost as surely as those of an object the target takes no
    // insert of, which end the load with errors: this one ended completed.
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const describes = describeFromDataset(dataset);
    delete describes.Contact; // Contact does not exist in the target
    const progress: Array<{ objectName?: string; status: string }> = [];
    const deps = makeDeps({ dataset, describes, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
    );

    expect(report.alignment.excludedObjects).toHaveLength(1);
    expect(report.alignment.excludedObjects[0].objectApiName).toBe('Contact');
    expect(calls.map((c) => c.objectApiName)).toEqual(['Account']);
    expect(report.status).toBe('completed-with-errors');
    expect(progress).toContainEqual(
      expect.objectContaining({ objectName: 'Contact', status: 'error' }),
    );
    // Counted with the records the target refused, for the report and the audit trail.
    expect(report.perObject.find((o) => o.objectApiName === 'Contact')).toEqual({
      objectApiName: 'Contact',
      fromFiles: 1,
      inserted: 0,
      reused: 0,
      skippedDuplicates: [],
      failed: [
        {
          objectApiName: 'Contact',
          referenceId: 'Contact-000001',
          errors: ['Not present in target org: sObject Contact not found'],
        },
      ],
    });
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Contact).toEqual({
      fromFiles: 1,
      exclusionReasons: { 'object-not-loaded': 1 },
      excluded: 1,
      added: 0,
      expected: 0,
    });
  });

  it('sends nothing of an object the target takes no insert of, and says the load had errors', async () => {
    // Run for real, the error log a quote had went to the target, which
    // refused it: "entity type cannot be inserted". Its describe said so.
    const dataset = makeAccountContactDataset();
    dataset.objects.push({
      objectApiName: 'RevenueTransactionErrorLog',
      records: [
        {
          referenceId: 'RevenueTransactionErrorLog-000001',
          fields: { PrimaryRecordId: 'Account-000001', ErrorMessage: 'pricing failed' },
        },
      ],
    });
    const describes = describeFromDataset(dataset);
    describes.RevenueTransactionErrorLog.createable = false;
    const calls: DmlCall[] = [];
    const progress: Array<{ objectName?: string; status: string; message: string }> = [];
    const deps = makeDeps({ dataset, describes, writer: makeWriter(calls) });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
    );

    expect(calls.map((c) => c.objectApiName)).toEqual(['Account', 'Contact']);
    expect(report.alignment.excludedObjects).toEqual([
      {
        objectApiName: 'RevenueTransactionErrorLog',
        reason: 'Not createable in target org: 1 record of the dataset not loaded',
      },
    ]);
    expect(report.status).toBe('completed-with-errors');
    expect(progress).toContainEqual(
      expect.objectContaining({ objectName: 'RevenueTransactionErrorLog', status: 'error' }),
    );
    expect(
      report.perObject.find((o) => o.objectApiName === 'RevenueTransactionErrorLog'),
    ).toMatchObject({
      inserted: 0,
      reused: 0,
      failed: [
        {
          objectApiName: 'RevenueTransactionErrorLog',
          referenceId: 'RevenueTransactionErrorLog-000001',
          errors: ['Not createable in target org: the running user may not insert it'],
        },
      ],
    });
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.RevenueTransactionErrorLog).toMatchObject({
      exclusionReasons: { 'object-not-loaded': 1 },
      expected: 0,
    });
  });

  it('counts, of an object the target takes no insert of, the records it links and the ones it could not write', async () => {
    // Excluded whole, the standard book the load matches was counted nowhere,
    // and the custom book it had to write was in no failure and no audit.
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Pricebook2',
          records: [
            { referenceId: 'Pricebook2-000001', fields: { Name: 'Standard' } },
            { referenceId: 'Pricebook2-000002', fields: { Name: 'Resellers' } },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
      standardPricebook: 'Pricebook2-000001',
    };
    const describes = describeFromDataset(dataset);
    describes.Pricebook2.createable = false;
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      describes,
      writer: makeWriter(calls),
      queryImpl: async (_org, soql) =>
        soql.includes('IsStandard = true') ? [{ Id: '01sTARGETSTANDARD' }] : [],
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(calls).toEqual([]);
    expect(report.status).toBe('completed-with-errors');
    expect(report.alignment.excludedObjects).toEqual([
      {
        objectApiName: 'Pricebook2',
        reason: 'Not createable in target org: 1 record of the dataset not loaded',
      },
    ]);
    expect(report.perObject).toEqual([
      {
        objectApiName: 'Pricebook2',
        fromFiles: 2,
        inserted: 0,
        reused: 1,
        skippedDuplicates: [],
        failed: [
          {
            objectApiName: 'Pricebook2',
            referenceId: 'Pricebook2-000002',
            errors: ['Not createable in target org: the running user may not insert it'],
          },
        ],
      },
    ]);
    // The book it links is in the org, and the verification counts it.
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Pricebook2).toMatchObject({ fromFiles: 2, excluded: 1, expected: 1 });
  });

  it('counts no error for an object the target takes no insert of when it only links its records', async () => {
    // A running user who may not create price books still loads prices into
    // the standard one, which the load matches and never writes.
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Pricebook2',
          records: [{ referenceId: 'Pricebook2-000001', fields: { Name: 'Standard' } }],
        },
        {
          objectApiName: 'Product2',
          records: [{ referenceId: 'Product2-000001', fields: { Name: 'A' } }],
        },
        {
          objectApiName: 'PricebookEntry',
          records: [
            {
              referenceId: 'PricebookEntry-000001',
              fields: {
                Pricebook2Id: 'Pricebook2-000001',
                Product2Id: 'Product2-000001',
                UnitPrice: 10,
              },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
      standardPricebook: 'Pricebook2-000001',
    };
    const describes = describeFromDataset(dataset);
    describes.Pricebook2.createable = false;
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      describes,
      writer: makeWriter(calls),
      queryImpl: async (_org, soql) =>
        soql.includes('IsStandard = true') ? [{ Id: '01sTARGETSTANDARD' }] : [],
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(report.status).toBe('completed');
    expect(report.alignment.excludedObjects).toEqual([]);
    expect(calls.map((c) => c.objectApiName)).toEqual(['Product2', 'PricebookEntry']);
    expect(report.perObject.find((o) => o.objectApiName === 'Pricebook2')).toMatchObject({
      inserted: 0,
      reused: 1,
    });
  });

  it('leaves out what the dataset cleared, so the target applies its own default', async () => {
    // '' is how the `clear` generator marks a removed value. Sent as-is, the
    // target read it as a value: an owner "cannot be blank".
    const dataset = makeAccountContactDataset();
    dataset.objects[0].records[0].fields = {
      Name: 'Anon Account',
      OwnerId: '',
      Description: null,
      ExternalId__c: 'ACC-1',
    };
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    await loader.load(makeOptions(deps, dataset));

    const account = calls.find((c) => c.objectApiName === 'Account')?.payload as Array<
      Record<string, unknown>
    >;
    expect(account[0]).toEqual({ Name: 'Anon Account', ExternalId__c: 'ACC-1' });
  });

  it('leaves an object with no record alone: no describe, no default, no placeholder', async () => {
    // Run for real, the load stopped on "Required field X.Name is absent from
    // the dataset" for an object whose file held no record at all.
    const dataset = makeAccountContactDataset();
    dataset.objects.push({ objectApiName: 'EmptyThing__c', records: [] });
    const calls: DmlCall[] = [];
    const describes = describeFromDataset(dataset, {
      EmptyThing__c: [
        field({ name: 'Name', nillable: false }),
        field({ name: 'Parent__c', type: 'reference', nillable: false, referenceTo: ['Account'] }),
      ],
    });
    const deps = makeDeps({ dataset, describes, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(report.status).toBe('completed');
    expect(report.placeholders).toEqual([]);
    expect(report.requiredDefaults).toEqual([]);
    expect(calls.map((c) => c.objectApiName)).toEqual(['Account', 'Contact']);
    expect(deps.orgAccess.describe).not.toHaveBeenCalledWith('00D-target', 'EmptyThing__c');
  });

  it('resolves RecordTypeId by DeveloperName, never by label', async () => {
    const dataset = makeAccountContactDataset();
    dataset.recordTypes = {
      Account: [{ name: 'Compte professionnel', developerName: 'Business_Account' }],
      Contact: [],
    };
    dataset.objects[0].records[0].fields.RecordTypeId = 'Compte professionnel';
    const resolveByDeveloperName = vi.fn(async () => '012RT-BUSINESS');
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls) });
    deps.recordTypeResolver = { resolveByDeveloperName };
    const loader = new FrozenDatasetLoader(deps);

    await loader.load(makeOptions(deps, dataset));

    expect(resolveByDeveloperName).toHaveBeenCalledWith(
      '00D-target',
      'Account',
      'Business_Account',
    );
    const accountPayload = calls.find((c) => c.objectApiName === 'Account')?.payload as Array<
      Record<string, unknown>
    >;
    expect(accountPayload[0].RecordTypeId).toBe('012RT-BUSINESS');
  });

  it('drops and lists a RecordType the running user cannot use', async () => {
    const dataset = makeAccountContactDataset();
    dataset.objects[0].records[0].fields.RecordTypeId = 'Business';
    dataset.recordTypes = { Account: [{ name: 'Business', developerName: 'Business_Account' }] };
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls) });
    deps.recordTypeResolver.resolveByDeveloperName = vi.fn(async () => ({
      unavailable: true as const,
      id: '012RT0000000001AAA',
    }));
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    const account = calls.find((c) => c.objectApiName === 'Account')?.payload as Array<
      Record<string, unknown>
    >;
    expect(account[0]).not.toHaveProperty('RecordTypeId');
    expect(report.alignment.recordTypeIssues).toEqual([
      expect.objectContaining({
        objectApiName: 'Account',
        recordTypeName: 'Business',
        detail: expect.stringContaining('not available to the running user'),
      }),
    ]);
  });

  it('drops and lists a RecordType unknown to the target org', async () => {
    const dataset = makeAccountContactDataset();
    dataset.recordTypes = {
      Account: [{ name: 'Compte professionnel', developerName: 'Business_Account' }],
      Contact: [],
    };
    dataset.objects[0].records[0].fields.RecordTypeId = 'Compte professionnel';
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls) });
    deps.recordTypeResolver = { resolveByDeveloperName: vi.fn(async () => null) };
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(report.alignment.recordTypeIssues).toHaveLength(1);
    expect(report.alignment.recordTypeIssues[0]).toMatchObject({
      objectApiName: 'Account',
      referenceId: 'Account-000001',
      recordTypeName: 'Compte professionnel',
    });
    const accountPayload = calls.find((c) => c.objectApiName === 'Account')?.payload as Array<
      Record<string, unknown>
    >;
    expect(accountPayload[0]).not.toHaveProperty('RecordTypeId');
  });
});

describe('FrozenDatasetLoader — required lookup placeholder', () => {
  it('creates ONE named, record-typed placeholder and points records at it', async () => {
    const dataset = makeAccountContactDataset();
    const describes = describeFromDataset(dataset, {
      Contact: [
        field({
          name: 'Mandatory_Lookup__c',
          type: 'reference',
          nillable: false,
          referenceTo: ['Account'],
        }),
      ],
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      describes,
      writer: makeWriter(calls),
      config: {
        requiredLookupPlaceholders: {
          'Contact.Mandatory_Lookup__c': {
            name: 'TECH_PLACEHOLDER_DO_NOT_USE',
            recordTypeDeveloperName: 'Business_Account',
          },
        },
      },
    });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    // Placeholder inserted on Account FIRST (Contacts point at it).
    expect(calls[0]).toMatchObject({ op: 'insert', objectApiName: 'Account' });
    const placeholderPayload = calls[0].payload as Array<Record<string, unknown>>;
    expect(placeholderPayload[0]).toEqual({
      Name: 'TECH_PLACEHOLDER_DO_NOT_USE',
      RecordTypeId: '012RT-RESOLVED',
    });
    const contactPayload = calls.find((c) => c.objectApiName === 'Contact')?.payload as Array<
      Record<string, unknown>
    >;
    expect(contactPayload[0].Mandatory_Lookup__c).toBe('REAL-Account-1');
    // Listed in the report, persisted in the mapping, counted in the contract.
    expect(report.placeholders).toEqual([
      {
        objectApiName: 'Contact',
        field: 'Mandatory_Lookup__c',
        placeholderObjectApiName: 'Account',
        placeholderName: 'TECH_PLACEHOLDER_DO_NOT_USE',
        placeholderId: 'REAL-Account-1',
        affectedRecords: 1,
      },
    ]);
    const mapping = await new SasReferenceIdMappingStore(deps.sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    expect(mapping.get('placeholder:Account:Contact.Mandatory_Lookup__c')).toBe('REAL-Account-1');
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Account).toMatchObject({ fromFiles: 1, added: 1, expected: 2 });
  });

  it('fails with an actionable error when no placeholder is configured', async () => {
    const dataset = makeAccountContactDataset();
    const describes = describeFromDataset(dataset, {
      Contact: [
        field({
          name: 'Mandatory_Lookup__c',
          type: 'reference',
          nillable: false,
          referenceTo: ['Account'],
        }),
      ],
    });
    const deps = makeDeps({ dataset, describes });
    const loader = new FrozenDatasetLoader(deps);

    await expect(loader.load(makeOptions(deps, dataset))).rejects.toThrow(LoadConfigError);
    await expect(loader.load(makeOptions(deps, dataset))).rejects.toThrow(
      /requiredLookupPlaceholders\["Contact\.Mandatory_Lookup__c"\]/,
    );
  });
});

describe('FrozenDatasetLoader — required fields the dataset leaves empty', () => {
  it('lists every gap in one refusal, and writes nothing', async () => {
    // One lookup has its placeholder declared, two scalars have no default.
    // Checked one at a time, the load created the placeholder and then
    // stopped on the first default: a technical record left in the target,
    // and one gap reported per attempt.
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const describes = describeFromDataset(dataset, {
      Contact: [
        field({
          name: 'Mandatory_Lookup__c',
          type: 'reference',
          nillable: false,
          referenceTo: ['Account'],
        }),
        field({ name: 'Region__c', nillable: false }),
      ],
      Account: [field({ name: 'Tier__c', nillable: false })],
    });
    const deps = makeDeps({
      dataset,
      describes,
      writer: makeWriter(calls),
      config: {
        requiredLookupPlaceholders: {
          'Contact.Mandatory_Lookup__c': { name: 'TECH_PLACEHOLDER_DO_NOT_USE' },
        },
      },
    });
    const loader = new FrozenDatasetLoader(deps);

    const refusal = await loader.load(makeOptions(deps, dataset)).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(LoadConfigError);
    const message = (refusal as Error).message;
    expect(message).toContain('requiredFieldDefaults["Account.Tier__c"]');
    expect(message).toContain('requiredFieldDefaults["Contact.Region__c"]');
    expect(message).toContain('Nothing was written.');
    expect(calls).toEqual([]);
  });

  it('refuses a placeholder whose record type the target lacks before creating any', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const describes = describeFromDataset(dataset, {
      Contact: [
        field({
          name: 'Mandatory_Lookup__c',
          type: 'reference',
          nillable: false,
          referenceTo: ['Account'],
        }),
      ],
    });
    const deps = makeDeps({
      dataset,
      describes,
      writer: makeWriter(calls),
      config: {
        requiredLookupPlaceholders: {
          'Contact.Mandatory_Lookup__c': {
            name: 'TECH_PLACEHOLDER_DO_NOT_USE',
            recordTypeDeveloperName: 'Missing_RT',
          },
        },
      },
    });
    deps.recordTypeResolver.resolveByDeveloperName = vi.fn(async () => null);
    const loader = new FrozenDatasetLoader(deps);

    await expect(loader.load(makeOptions(deps, dataset))).rejects.toThrow(
      /record type Missing_RT is not on Account/,
    );
    expect(calls).toEqual([]);
  });

  describe('of the records it only links', () => {
    /**
     * Two price books, the standard one the load matches and one it writes,
     * and a selling model the target already holds under its key — each with
     * the name the rules cleared.
     */
    function linkedDataset(): FrozenDataset {
      return {
        datasetVersion: '1.0.0',
        objects: [
          {
            objectApiName: 'Pricebook2',
            records: [
              { referenceId: 'Pricebook2-000001', fields: { Name: '' } },
              { referenceId: 'Pricebook2-000002', fields: { Name: '' } },
            ],
          },
          {
            objectApiName: 'ProductSellingModel',
            records: [
              {
                referenceId: 'ProductSellingModel-000001',
                fields: {
                  Name: '',
                  SellingModelType: 'OneTime',
                  PricingTerm: null,
                  PricingTermUnit: null,
                },
              },
            ],
          },
        ],
        recordTypes: {},
        personContactSidecar: [],
        standardPricebook: 'Pricebook2-000001',
      };
    }

    /** The target: both objects want a name, and it holds the book and the model. */
    function linkingTarget(dataset: FrozenDataset) {
      const describes = describeFromDataset(dataset);
      for (const describe of Object.values(describes)) {
        describe.fields = describe.fields.map((f) =>
          f.name === 'Name' ? { ...f, nillable: false } : f,
        );
      }
      const queryImpl = async (_org: string, soql: string) => {
        if (soql.includes('IsStandard = true')) return [{ Id: '01sTARGETSTANDARD' }];
        if (soql.includes('FROM ProductSellingModel WHERE')) return [{ Id: '0jPTARGETONETIME' }];
        return [];
      };
      return { describes, queryImpl };
    }

    it('asks no default for a field the rules cleared on a record it never writes', async () => {
      // Asked, the load refused to write anything until a name was declared
      // for a selling model it only links.
      const dataset = linkedDataset();
      dataset.objects = dataset.objects.filter((o) => o.objectApiName === 'ProductSellingModel');
      const calls: DmlCall[] = [];
      const deps = makeDeps({ dataset, writer: makeWriter(calls), ...linkingTarget(dataset) });

      const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

      expect(report.status).toBe('completed');
      expect(report.requiredDefaults).toEqual([]);
      expect(calls).toEqual([]);
      expect(report.perObject.find((o) => o.objectApiName === 'ProductSellingModel')).toMatchObject(
        { inserted: 0, reused: 1 },
      );
    });

    it('asks it for the records it writes, and fills only those', async () => {
      // The standard book is matched, the other one written: its name is what
      // the default is for, and the report counts the one record it went into.
      const dataset = linkedDataset();
      const calls: DmlCall[] = [];
      const deps = makeDeps({
        dataset,
        writer: makeWriter(calls),
        ...linkingTarget(dataset),
        config: { requiredFieldDefaults: { 'Pricebook2.Name': 'Loaded book' } },
      });

      const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

      expect(report.requiredDefaults).toEqual([
        { objectApiName: 'Pricebook2', field: 'Name', value: 'Loaded book', affectedRecords: 1 },
      ]);
      expect(calls.map((c) => [c.objectApiName, c.payload])).toEqual([
        ['Pricebook2', [{ Name: 'Loaded book' }]],
      ]);
    });
  });
});

describe('FrozenDatasetLoader — insertion order', () => {
  it('keeps a cycle together and loads what depends on it after it', async () => {
    // Account → its key Contact, Contact → its Account: a cycle. The
    // relation between them needs both. Ordered by a sort that gave up at the
    // first cycle, the relation went in alphabetically — before its Contact.
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Account',
          records: [
            {
              referenceId: 'Account-000001',
              fields: { Name: 'A', KeyContact__c: 'Contact-000001' },
            },
          ],
        },
        {
          objectApiName: 'AccountContactRelation',
          records: [
            {
              referenceId: 'AccountContactRelation-000001',
              fields: { AccountId: 'Account-000001', ContactId: 'Contact-000001' },
            },
          ],
        },
        {
          objectApiName: 'Contact',
          records: [
            {
              referenceId: 'Contact-000001',
              fields: { LastName: 'Doe', AccountId: 'Account-000001' },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(calls.filter((c) => c.op === 'insert').map((c) => c.objectApiName)).toEqual([
      'Account',
      'Contact',
      'AccountContactRelation',
    ]);
    const relation = calls.find((c) => c.objectApiName === 'AccountContactRelation')
      ?.payload as Array<Record<string, unknown>>;
    expect(relation[0]).toEqual({ AccountId: 'REAL-Account-1', ContactId: 'REAL-Contact-2' });
    expect(report.pass2.unresolved).toEqual([]);
  });

  it('inside a cycle, loads first what a required lookup points at', async () => {
    // Alpha__c must name its Zulu__c; Zulu__c may name an Alpha__c. In
    // alphabetical order Alpha__c went first, with the required lookup empty.
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Alpha__c',
          records: [{ referenceId: 'Alpha__c-000001', fields: { Zulu__c: 'Zulu__c-000001' } }],
        },
        {
          objectApiName: 'Zulu__c',
          records: [{ referenceId: 'Zulu__c-000001', fields: { Alpha__c: 'Alpha__c-000001' } }],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
    const describes: Record<string, TargetObjectDescribe> = {
      Alpha__c: {
        name: 'Alpha__c',
        fields: [
          field({ name: 'Zulu__c', type: 'reference', nillable: false, referenceTo: ['Zulu__c'] }),
        ],
      },
      Zulu__c: {
        name: 'Zulu__c',
        fields: [field({ name: 'Alpha__c', type: 'reference', referenceTo: ['Alpha__c'] })],
      },
    };
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, describes, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(calls.filter((c) => c.op === 'insert').map((c) => c.objectApiName)).toEqual([
      'Zulu__c',
      'Alpha__c',
    ]);
    const alpha = calls.find((c) => c.objectApiName === 'Alpha__c')?.payload as Array<
      Record<string, unknown>
    >;
    expect(alpha[0].Zulu__c).toBe('REAL-Zulu__c-1');
    // The optional side waits for pass 2, as a cycle FK always has.
    expect(report.pass2.resolved).toBe(1);
  });
});

describe('FrozenDatasetLoader — records the platform owns', () => {
  it('matches the standard price book and writes standard prices before custom ones', async () => {
    // The target takes no custom price for a product without a standard one,
    // and every org has exactly one standard book, which none can create.
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
            {
              referenceId: 'PricebookEntry-000001',
              fields: {
                Pricebook2Id: 'Pricebook2-000001',
                Product2Id: 'Product2-000001',
                UnitPrice: 9,
              },
            },
            {
              referenceId: 'PricebookEntry-000002',
              fields: {
                Pricebook2Id: 'Pricebook2-000002',
                Product2Id: 'Product2-000001',
                UnitPrice: 10,
              },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
      standardPricebook: 'Pricebook2-000002',
    };
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      queryImpl: async (_org, soql) =>
        soql.includes('IsStandard = true') ? [{ Id: '01sTARGETSTANDARD' }] : [],
    });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    const books = calls.filter((c) => c.objectApiName === 'Pricebook2');
    expect(books.flatMap((c) => c.payload as unknown[])).toEqual([{ Name: 'Resellers' }]);
    const prices = calls.filter((c) => c.objectApiName === 'PricebookEntry');
    expect(
      prices.map((c) => (c.payload as Array<Record<string, unknown>>)[0].Pricebook2Id),
    ).toEqual(['01sTARGETSTANDARD', 'REAL-Pricebook2-1']);
    expect(report.perObject.find((o) => o.objectApiName === 'Pricebook2')).toMatchObject({
      fromFiles: 2,
      inserted: 1,
      reused: 1,
    });
    expect(report.perObject.find((o) => o.objectApiName === 'PricebookEntry')).toMatchObject({
      fromFiles: 2,
      inserted: 2,
    });
  });

  it('finds the direct relation the platform made instead of inserting it again', async () => {
    // A Contact inserted with an AccountId gets its direct relation from
    // Salesforce; inserted a second time it is refused: "the contact already
    // has a relationship with this account".
    const dataset = makeAccountContactDataset();
    dataset.objects.push({
      objectApiName: 'AccountContactRelation',
      records: [
        {
          referenceId: 'AccountContactRelation-000001',
          fields: { AccountId: 'Account-000001', ContactId: 'Contact-000001' },
        },
      ],
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      queryImpl: async (_org, soql) =>
        soql.includes('FROM AccountContactRelation WHERE IsDirect = true')
          ? [{ Id: '07kDIRECT', AccountId: 'REAL-Account-1', ContactId: 'REAL-Contact-2' }]
          : [],
    });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(calls.map((c) => c.objectApiName)).not.toContain('AccountContactRelation');
    expect(
      report.perObject.find((o) => o.objectApiName === 'AccountContactRelation'),
    ).toMatchObject({ fromFiles: 1, inserted: 0, reused: 1, failed: [] });
    const mapping = await new SasReferenceIdMappingStore(deps.sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    expect(mapping.get('AccountContactRelation-000001')).toBe('07kDIRECT');
  });
});

describe('FrozenDatasetLoader — what removing the load takes', () => {
  /** What the load's mapping says of it, read as the removal reads it. */
  async function recorded(sasDir: string) {
    return new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).recorded();
  }

  it('keeps as created every record it inserted, and never the standard book it matched', async () => {
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
            {
              referenceId: 'PricebookEntry-000001',
              fields: { Pricebook2Id: 'Pricebook2-000001', Product2Id: 'Product2-000001' },
            },
            {
              referenceId: 'PricebookEntry-000002',
              fields: { Pricebook2Id: 'Pricebook2-000002', Product2Id: 'Product2-000001' },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
      standardPricebook: 'Pricebook2-000002',
    };
    const deps = makeDeps({
      dataset,
      queryImpl: async (_org, soql) =>
        soql.includes('IsStandard = true') ? [{ Id: '01sTARGETSTANDARD' }] : [],
    });
    const started = new Date('2026-09-24T10:00:00.000Z');

    await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { now: () => started }));

    const load = await recorded(deps.sasDir);
    expect(load?.mapping.get('Pricebook2-000002')).toBe('01sTARGETSTANDARD');
    // One entry per object, in the order written: the standard price, in its
    // own call before the custom one, first.
    expect(load?.created).toEqual([
      { objectApiName: 'Pricebook2', referenceIds: ['Pricebook2-000001'] },
      { objectApiName: 'Product2', referenceIds: ['Product2-000001'] },
      {
        objectApiName: 'PricebookEntry',
        referenceIds: ['PricebookEntry-000002', 'PricebookEntry-000001'],
      },
    ]);
    expect(load?.startedAt).toBe(started.toISOString());
  });

  it('keeps as created the placeholder it made for a required lookup', async () => {
    const dataset = makeAccountContactDataset();
    const describes = describeFromDataset(dataset, {
      Contact: [
        field({
          name: 'Mandatory_Lookup__c',
          type: 'reference',
          nillable: false,
          referenceTo: ['Account'],
        }),
      ],
    });
    const deps = makeDeps({
      dataset,
      describes,
      config: {
        requiredLookupPlaceholders: {
          'Contact.Mandatory_Lookup__c': { name: 'TECH_PLACEHOLDER_DO_NOT_USE' },
        },
      },
    });

    await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect((await recorded(deps.sasDir))?.created).toEqual([
      {
        objectApiName: 'Account',
        referenceIds: ['placeholder:Account:Contact.Mandatory_Lookup__c', 'Account-000001'],
      },
      { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
    ]);
  });

  it('keeps as linked what a reload found by its identity keys and no load created', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    // The last load linked the account the target held, and created a contact.
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map([
        ['Account-000001', '001TARGETS-OWN'],
        ['Contact-000001', '003OLD-CONTACT'],
      ]),
      {
        created: [{ objectApiName: 'Contact', referenceIds: ['Contact-000001'] }],
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
      },
    );
    const deps = makeDeps({
      dataset,
      sasDir,
      config: { identityKeys: { Account: ['ExternalId__c'] } },
      queryImpl: async (_org, soql) =>
        soql.includes('FROM Account') ? [{ Id: '001TARGETS-OWN', ExternalId__c: 'ACC-1' }] : [],
    });

    await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { reload: true }));

    const load = await recorded(sasDir);
    expect(load?.mapping.get('Account-000001')).toBe('001TARGETS-OWN');
    expect(load?.created).toEqual([{ objectApiName: 'Contact', referenceIds: ['Contact-000001'] }]);
  });

  it('keeps as created what a reload found again of the records the load before it created', async () => {
    // Kept as linked, the account would never go: neither with the removal
    // of this load, nor with the purge of the next reload, which takes only
    // what a load created.
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map([['Account-000001', '001OLD-ACCOUNT']]),
      {
        created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
      },
    );
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeWriter(calls),
      config: { identityKeys: { Account: ['ExternalId__c'] } },
      queryImpl: async (_org, soql) =>
        soql.includes('FROM Account') ? [{ Id: '001OLD-ACCOUNT', ExternalId__c: 'ACC-1' }] : [],
    });

    await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { reload: true }));

    expect(calls.filter((c) => c.op === 'delete')).toEqual([]);
    const loads = await new SasReferenceIdMappingStore(sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).recordedLoads();
    // One load: the reload took the account over, and nothing of the load
    // before it is left to remove.
    expect(loads).toHaveLength(1);
    expect(loads[0].mapping.get('Account-000001')).toBe('001OLD-ACCOUNT');
    expect(loads[0].created).toEqual([
      { objectApiName: 'Account', referenceIds: ['Account-000001'] },
      { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
    ]);
  });

  it('keeps, after a cancel, the load before it with what the purge had not reached', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await new SasReferenceIdMappingStore(sasDir, {
      guard: new SasPathGuard(repoRoot),
      now: () => new Date('2026-09-23T10:05:00.000Z'),
    }).persist(
      new Map([
        ['Account-000001', '001OLD-ACCOUNT'],
        ['Contact-000001', '003OLD-CONTACT'],
        ['Pricebook2-000001', '01sTARGETSTANDARD'],
      ]),
      {
        created: [
          { objectApiName: 'Account', referenceIds: ['Account-000001'] },
          { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
        ],
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
      },
    );
    const stop = new AbortController();
    const calls: DmlCall[] = [];
    const writer = makeWriter(calls);
    const remove = writer.delete;
    writer.delete = vi.fn(async (...args: Parameters<FrozenDmlWriter['delete']>) => {
      stop.abort();
      return remove(...args);
    });
    const deps = makeDeps({ dataset, sasDir, writer });

    await expect(
      new FrozenDatasetLoader(deps).load(
        makeOptions(deps, dataset, { reload: true, signal: stop.signal }),
      ),
    ).rejects.toBeInstanceOf(FrozenLoadCancelledError);

    // The contact went before the cancel; the price book it linked never was the purge's.
    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual(['delete:Contact']);
    const loads = await new SasReferenceIdMappingStore(sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).recordedLoads();
    expect(loads.map((load) => load.earlier === true)).toEqual([false, true]);
    // Removing the load before it takes the account, as the next reload would purge it.
    expect(loads[1]).toMatchObject({
      endedAt: '2026-09-23T10:05:00.000Z',
      created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
    });
    expect(loads[1].mapping).toEqual(
      new Map([
        ['Account-000001', '001OLD-ACCOUNT'],
        ['Pricebook2-000001', '01sTARGETSTANDARD'],
      ]),
    );
  });
});

describe("FrozenDatasetLoader — the target's dates of what it wrote", () => {
  /** What the load's mapping says of it, read as the removal reads it. */
  const recorded = (sasDir: string) =>
    new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).recorded();

  /** The target answering the read of its records' dates, and recording each one. */
  function targetDates(dates: Record<string, Record<string, string>>, reads: string[] = []) {
    return async (_org: string, soql: string): Promise<Array<Record<string, unknown>>> => {
      const match = /^SELECT Id, .+ FROM \w+ WHERE Id IN \((.*)\)$/.exec(soql);
      if (!match) return [];
      reads.push(soql);
      return match[1]
        .split(', ')
        .map((quoted) => quoted.slice(1, -1))
        .flatMap((id) => (dates[id] ? [{ Id: id, ...dates[id] }] : []));
    };
  }

  const at = (time: string) => ({
    CreatedDate: `2026-09-24T${time}.000+0000`,
    LastModifiedDate: `2026-09-24T${time}.000+0000`,
    SystemModstamp: `2026-09-24T${time}.000+0000`,
  });

  it('keeps the earliest creation and the latest modification the target gave what it created', async () => {
    const dataset = makeAccountContactDataset();
    const deps = makeDeps({
      dataset,
      queryImpl: targetDates({
        'REAL-Account-1': { ...at('10:00:01'), LastModifiedDate: '2026-09-24T10:00:07.000+0000' },
        'REAL-Contact-2': at('10:00:02'),
      }),
    });

    // This machine's clock runs an hour behind the org's: never compared.
    await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { now: () => new Date('2026-09-24T09:00:00.000Z') }),
    );

    expect((await recorded(deps.sasDir))?.writtenBetween).toEqual({
      first: '2026-09-24T10:00:01.000Z',
      last: '2026-09-24T10:00:07.000Z',
    });
  });

  it('dates by their system stamp the records it sent the audit dates of the source for', async () => {
    // The rules kept the source's creation date, and the target lets the
    // running user set it: the account says it was created years ago.
    const dataset = makeAccountContactDataset();
    dataset.objects[0].records[0].fields.CreatedDate = '2019-05-01T08:00:00.000Z';
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      queryImpl: targetDates({
        'REAL-Account-1': {
          CreatedDate: '2019-05-01T08:00:00.000+0000',
          LastModifiedDate: '2019-05-01T08:00:00.000+0000',
          SystemModstamp: '2026-09-24T10:00:03.000+0000',
        },
        'REAL-Contact-2': at('10:00:02'),
      }),
    });

    await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    const sent = calls.find((c) => c.op === 'insert' && c.objectApiName === 'Account');
    expect((sent?.payload as Array<Record<string, unknown>>)[0].CreatedDate).toBe(
      '2019-05-01T08:00:00.000Z',
    );
    expect((await recorded(deps.sasDir))?.writtenBetween).toEqual({
      first: '2026-09-24T10:00:02.000Z',
      last: '2026-09-24T10:00:03.000Z',
    });
  });

  it('leaves the load undated when the target does not give every date', async () => {
    const dataset = makeAccountContactDataset();
    const answer = targetDates({ 'REAL-Account-1': at('10:00:01') });
    const deps = makeDeps({
      dataset,
      queryImpl: async (org, soql) => {
        if (soql.includes('FROM Contact WHERE Id IN')) throw new Error('INVALID_TYPE');
        return answer(org, soql);
      },
    });

    await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    const load = await recorded(deps.sasDir);
    expect(load?.writtenBetween).toBeUndefined();
    // Dated by this machine's clock instead, as the removal falls back to.
    expect(load?.startedAt).toBeDefined();
  });

  it('reads no date of what an earlier load created and it reuses: written before it began', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map([['Account-000001', '001OLD-ACCOUNT']]),
      {
        created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
        startedAt: new Date('2026-09-20T10:00:00.000Z'),
      },
    );
    const reads: string[] = [];
    const dates = targetDates(
      {
        '001OLD-ACCOUNT': at('08:00:00'),
        'REAL-Contact-1': at('10:00:02'),
      },
      reads,
    );
    const deps = makeDeps({
      dataset,
      sasDir,
      config: { identityKeys: { Account: ['ExternalId__c'] } },
      queryImpl: async (org, soql) =>
        soql.includes('ExternalId__c')
          ? [{ Id: '001OLD-ACCOUNT', ExternalId__c: 'ACC-1' }]
          : dates(org, soql),
    });

    await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { reload: true }));

    expect(reads.some((soql) => soql.includes('001OLD-ACCOUNT'))).toBe(false);
    expect((await recorded(sasDir))?.writtenBetween).toEqual({
      first: '2026-09-24T10:00:02.000Z',
      last: '2026-09-24T10:00:02.000Z',
    });
  });

  it('dates what it wrote before a cancel', async () => {
    const dataset = makeAccountContactDataset();
    const stop = new AbortController();
    const writer = makeWriter([]);
    const insert = writer.insert;
    writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
      stop.abort();
      return insert(...args);
    });
    const deps = makeDeps({
      dataset,
      writer,
      queryImpl: targetDates({ 'REAL-Account-1': at('10:00:01') }),
    });

    await expect(
      new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { signal: stop.signal })),
    ).rejects.toBeInstanceOf(FrozenLoadCancelledError);

    expect((await recorded(deps.sasDir))?.writtenBetween).toEqual({
      first: '2026-09-24T10:00:01.000Z',
      last: '2026-09-24T10:00:01.000Z',
    });
  });

  it('dates what it wrote before a failure', async () => {
    const dataset = makeAccountContactDataset();
    const writer = makeWriter([]);
    const insert = writer.insert;
    writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
      if (args[1] === 'Contact') throw new Error('Bulk job failed: the connection was reset');
      return insert(...args);
    });
    const deps = makeDeps({
      dataset,
      writer,
      queryImpl: targetDates({ 'REAL-Account-1': at('10:00:01') }),
    });

    await expect(
      new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)),
    ).rejects.toBeInstanceOf(FrozenLoadFailedError);

    expect((await recorded(deps.sasDir))?.writtenBetween).toEqual({
      first: '2026-09-24T10:00:01.000Z',
      last: '2026-09-24T10:00:01.000Z',
    });
  });
});

describe('FrozenDatasetLoader — a catalog sold under selling models', () => {
  const TARGET_MODEL = '0jPTARGETONETIME';
  const TARGET_PRODUCT = '01tTARGETPRODUCT';
  const TARGET_OPTION = '0iOTARGETOPTION';

  /**
   * One product priced in the standard book under a one-time selling model,
   * with the option that lets it be sold so — as an extraction carries it.
   */
  function soldUnderAModel(sellingModelType: string = 'OneTime'): FrozenDataset {
    return {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Pricebook2',
          records: [{ referenceId: 'Pricebook2-000001', fields: { Name: 'Standard' } }],
        },
        {
          objectApiName: 'Product2',
          records: [{ referenceId: 'Product2-000001', fields: { Name: 'A', ProductCode: 'P-1' } }],
        },
        {
          objectApiName: 'ProductSellingModel',
          records: [
            {
              referenceId: 'ProductSellingModel-000001',
              fields: {
                Name: 'One-time',
                SellingModelType: sellingModelType,
                PricingTerm: null,
                PricingTermUnit: null,
              },
            },
          ],
        },
        {
          objectApiName: 'ProductSellingModelOption',
          records: [
            {
              referenceId: 'ProductSellingModelOption-000001',
              fields: {
                Product2Id: 'Product2-000001',
                ProductSellingModelId: 'ProductSellingModel-000001',
              },
            },
          ],
        },
        {
          objectApiName: 'PricebookEntry',
          records: [
            {
              referenceId: 'PricebookEntry-000001',
              fields: {
                Pricebook2Id: 'Pricebook2-000001',
                Product2Id: 'Product2-000001',
                ProductSellingModelId: 'ProductSellingModel-000001',
                UnitPrice: 10,
              },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
      standardPricebook: 'Pricebook2-000001',
    };
  }

  /**
   * A target that sells under a one-time selling model, as the real one did:
   * it keeps one model per type, term and unit and refuses a second without
   * naming the one it holds, and takes no price for a product under a model
   * the product has no option for.
   */
  function sellingTarget(held: { products?: boolean; options?: boolean } = {}) {
    const calls: DmlCall[] = [];
    const queries: string[] = [];
    const options = new Set<string>(held.options ? [`${TARGET_PRODUCT}|${TARGET_MODEL}`] : []);
    let counter = 0;
    const accepted = (objectApiName: string) => ({
      id: `REAL-${objectApiName}-${++counter}`,
      success: true,
      errors: [],
    });
    const refused = (error: string) => ({ success: false, errors: [error] });
    const writer = makeWriter(calls);
    writer.insert = vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'insert', objectApiName, payload: records });
        return records.map((record) => {
          if (objectApiName === 'ProductSellingModel') {
            // A model with no type is given the one-time type the target holds.
            return (record.SellingModelType ?? 'OneTime') === 'OneTime'
              ? refused(
                  'DUPLICATE_VALUE: a product selling model already exists for this combination',
                )
              : accepted(objectApiName);
          }
          const pair = `${String(record.Product2Id)}|${String(record.ProductSellingModelId)}`;
          if (objectApiName === 'ProductSellingModelOption') {
            if (!record.Product2Id || !record.ProductSellingModelId) {
              return refused('REQUIRED_FIELD_MISSING: Product2Id, ProductSellingModelId');
            }
            if (options.has(pair)) return refused('DUPLICATE_VALUE: duplicate value found');
            options.add(pair);
            return accepted(objectApiName);
          }
          if (objectApiName === 'PricebookEntry' && record.ProductSellingModelId) {
            if (!options.has(pair)) {
              return refused(
                'FIELD_INTEGRITY_EXCEPTION: add a product selling model option to the product first',
              );
            }
          }
          return accepted(objectApiName);
        });
      },
    );
    writer.update = vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'update', objectApiName, payload: records });
        // The platform takes the selling model of a price at insert or never.
        return records.map((r) =>
          objectApiName === 'PricebookEntry' && 'ProductSellingModelId' in r
            ? refused('INVALID_FIELD_FOR_INSERT_UPDATE: ProductSellingModelId')
            : { id: String(r.Id), success: true, errors: [] },
        );
      },
    );
    const queryImpl = async (_org: string, soql: string) => {
      queries.push(soql);
      if (soql === 'SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1') {
        return [{ Id: '01sTARGETSTANDARD' }];
      }
      if (
        soql.includes('FROM ProductSellingModel WHERE') &&
        soql.includes("SellingModelType = 'OneTime'") &&
        soql.includes('PricingTerm = null') &&
        soql.includes('PricingTermUnit = null')
      ) {
        return [{ Id: TARGET_MODEL }];
      }
      if (soql.includes('FROM Product2 WHERE') && held.products) {
        return [{ Id: TARGET_PRODUCT, ProductCode: 'P-1' }];
      }
      if (soql.includes('FROM ProductSellingModelOption WHERE') && held.options) {
        return soql.includes(`'${TARGET_PRODUCT}'`)
          ? [{ Id: TARGET_OPTION, Product2Id: TARGET_PRODUCT, ProductSellingModelId: TARGET_MODEL }]
          : [];
      }
      return [];
    };
    return { calls, queries, writer, queryImpl };
  }

  it('links the selling model the target already holds, and writes the prices under it', async () => {
    // Inserted again, the model was refused and skipped as a duplicate: the
    // price went in without it, a lookup the platform takes at insert or
    // never, and pass 2 listed it unresolved.
    const dataset = soldUnderAModel();
    const target = sellingTarget();
    const deps = makeDeps({ dataset, writer: target.writer, queryImpl: target.queryImpl });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(target.calls.map((c) => c.objectApiName)).not.toContain('ProductSellingModel');
    expect(report.perObject.find((o) => o.objectApiName === 'ProductSellingModel')).toMatchObject({
      fromFiles: 1,
      inserted: 0,
      reused: 1,
      skippedDuplicates: [],
      failed: [],
    });
    const payloadOf = (objectApiName: string) =>
      (target.calls.find((c) => c.objectApiName === objectApiName)?.payload ?? []) as Array<
        Record<string, unknown>
      >;
    expect(payloadOf('ProductSellingModelOption')[0].ProductSellingModelId).toBe(TARGET_MODEL);
    expect(payloadOf('PricebookEntry')[0]).toMatchObject({
      Pricebook2Id: '01sTARGETSTANDARD',
      ProductSellingModelId: TARGET_MODEL,
    });
    expect(report.perObject.find((o) => o.objectApiName === 'PricebookEntry')).toMatchObject({
      inserted: 1,
      failed: [],
    });
    expect(report.pass2.unresolved).toEqual([]);
    expect(report.status).toBe('completed');
    const mapping = await new SasReferenceIdMappingStore(deps.sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    expect(mapping.get('ProductSellingModel-000001')).toBe(TARGET_MODEL);
  });

  it('writes the options before the prices that need them', async () => {
    // A price points at no option, so by their lookups the two were ready
    // together and went in by name — the prices first, every one refused.
    const dataset = soldUnderAModel();
    const target = sellingTarget();
    const deps = makeDeps({ dataset, writer: target.writer, queryImpl: target.queryImpl });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    const inserted = target.calls.filter((c) => c.op === 'insert').map((c) => c.objectApiName);
    expect(inserted.indexOf('ProductSellingModelOption')).toBeGreaterThanOrEqual(0);
    expect(inserted.indexOf('ProductSellingModelOption')).toBeLessThan(
      inserted.indexOf('PricebookEntry'),
    );
    expect(report.perObject.find((o) => o.objectApiName === 'PricebookEntry')).toMatchObject({
      inserted: 1,
      failed: [],
    });
  });

  it('links the option the target holds for a product and a model it already holds', async () => {
    // Reloaded over a target whose product the identity keys find: the
    // target already sells it under the model, through its own option.
    // Inserted again, the option was refused; and the last load's link to it
    // was purged as a record that load wrote, with the model it joins.
    const dataset = soldUnderAModel();
    const sasDir = makeTmpDir();
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map([
        ['Product2-000001', TARGET_PRODUCT],
        ['ProductSellingModel-000001', TARGET_MODEL],
        ['ProductSellingModelOption-000001', TARGET_OPTION],
        ['PricebookEntry-000001', '01uLASTLOAD'],
      ]),
    );
    const target = sellingTarget({ products: true, options: true });
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: target.writer,
      queryImpl: target.queryImpl,
      config: { identityKeys: { Product2: ['ProductCode'] } },
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { reload: true }),
    );

    const deleted = target.calls
      .filter((c) => c.op === 'delete')
      .flatMap((c) => c.payload as string[]);
    expect(deleted).toEqual(['01uLASTLOAD']);
    const inserted = target.calls.filter((c) => c.op === 'insert').map((c) => c.objectApiName);
    expect(inserted).toEqual(['PricebookEntry']);
    expect(
      report.perObject.find((o) => o.objectApiName === 'ProductSellingModelOption'),
    ).toMatchObject({ inserted: 0, reused: 1, skippedDuplicates: [], failed: [] });
    expect(report.status).toBe('completed');
  });

  it('matches no model whose key the rules cleared', async () => {
    // '' is what the `clear` generator leaves: the dataset no longer says
    // which model it was, and a key read as empty could only find another.
    const dataset = soldUnderAModel('');
    const target = sellingTarget();
    const deps = makeDeps({ dataset, writer: target.writer, queryImpl: target.queryImpl });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(target.queries.filter((soql) => soql.includes('FROM ProductSellingModel '))).toEqual([]);
    expect(
      report.perObject.find((o) => o.objectApiName === 'ProductSellingModel')?.skippedDuplicates,
    ).toHaveLength(1);
  });
});

describe('FrozenDatasetLoader — statuses with a lifecycle', () => {
  function orderDataset(status: string): FrozenDataset {
    return {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Order',
          records: [{ referenceId: 'Order-000001', fields: { Status: status } }],
        },
        {
          objectApiName: 'OrderItem',
          records: [
            { referenceId: 'OrderItem-000001', fields: { OrderId: 'Order-000001', Quantity: 2 } },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
  }
  const statusRows = async (_org: string, soql: string) =>
    soql.includes('FROM OrderStatus')
      ? [
          { ApiName: 'ST002', StatusCode: 'Activated' },
          { ApiName: 'ST001', StatusCode: 'Draft' },
        ]
      : [];

  it('creates an activated order as a draft, and activates it once its items are in', async () => {
    // Run for real: "for a new order, choose Draft" — an order is born a
    // draft, takes its products as a draft, and moves on afterwards.
    const dataset = orderDataset('ST002');
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls), queryImpl: statusRows });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual([
      'insert:Order',
      'insert:OrderItem',
      'update:Order',
    ]);
    expect((calls[0].payload as Array<Record<string, unknown>>)[0].Status).toBe('ST001');
    expect(calls[2].payload).toEqual([{ Id: 'REAL-Order-1', Status: 'ST002' }]);
    expect(report.statuses).toEqual({ restored: 1, refused: [] });
    expect(report.status).toBe('completed');
  });

  it('leaves a draft order as it is', async () => {
    const dataset = orderDataset('ST001');
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls), queryImpl: statusRows });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(calls.map((c) => c.op)).toEqual(['insert', 'insert']);
    expect(report.statuses).toEqual({ restored: 0, refused: [] });
  });

  it('lists a status the target refuses to apply, and says the load had errors', async () => {
    const dataset = orderDataset('ST002');
    const calls: DmlCall[] = [];
    const writer = makeWriter(calls);
    writer.update = vi.fn(
      async (_org: string, _object: string, records: Array<Record<string, unknown>>) =>
        records.map(() => ({ id: '', success: false, errors: ['Order has no products'] })),
    );
    const deps = makeDeps({ dataset, writer, queryImpl: statusRows });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(report.statuses.refused).toEqual([
      {
        objectApiName: 'Order',
        referenceId: 'Order-000001',
        status: 'ST002',
        detail: 'Order has no products',
      },
    ]);
    expect(report.status).toBe('completed-with-errors');
  });
});

describe('FrozenDatasetLoader — cycles and PersonContact post-load', () => {
  it('handles a 2-object cycle with the 2-pass pattern (nullify then patch)', async () => {
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'ObjA__c',
          records: [
            { referenceId: 'ObjA__c-000001', fields: { Name: 'A', B__c: 'ObjB__c-000001' } },
          ],
        },
        {
          objectApiName: 'ObjB__c',
          records: [
            { referenceId: 'ObjB__c-000001', fields: { Name: 'B', A__c: 'ObjA__c-000001' } },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual([
      'insert:ObjA__c',
      'insert:ObjB__c',
      'update:ObjA__c',
    ]);
    // Pass 1: the cyclic FK of ObjA__c is left out (target not inserted yet);
    // ObjB__c inserts directly with the real ObjA__c ID.
    expect((calls[0].payload as Array<Record<string, unknown>>)[0]).not.toHaveProperty('B__c');
    expect((calls[1].payload as Array<Record<string, unknown>>)[0].A__c).toBe('REAL-ObjA__c-1');
    // Pass 2: targeted update patches the nullified FK.
    expect(calls[2].payload).toEqual([{ Id: 'REAL-ObjA__c-1', B__c: 'REAL-ObjB__c-2' }]);
    expect(report.pass2).toEqual({ resolved: 1, unresolved: [] });
  });

  it('restores Account.PersonContactId from the sidecar as targeted updates', async () => {
    const dataset = makeAccountContactDataset();
    // The frozen Account carries the sidecar referenceId in PersonContactId
    // (the field does not exist at insert time).
    dataset.objects[0].records[0].fields.PersonContactId = 'Contact-000001';
    dataset.personContactSidecar = [
      { accountReferenceId: 'Account-000001', contactReferenceId: 'Contact-000001' },
    ];
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    // PersonContactId is never inserted…
    const accountPayload = calls.find((c) => c.op === 'insert' && c.objectApiName === 'Account')
      ?.payload as Array<Record<string, unknown>>;
    expect(accountPayload[0]).not.toHaveProperty('PersonContactId');
    // …it is posted post-load as a targeted update, resolved via the mapping.
    const update = calls.find((c) => c.op === 'update' && c.objectApiName === 'Account');
    expect(update?.payload).toEqual([{ Id: 'REAL-Account-1', PersonContactId: 'REAL-Contact-2' }]);
    expect(report.personContact).toEqual({ restored: 1, unresolved: [] });
  });

  describe('a link it could not make, and why', () => {
    /**
     * The writer of {@link makeWriter}, refusing the insert of each record
     * named in `names` and every update of the objects in `updates`, with the
     * error given for it.
     */
    function refusingWriter(
      calls: DmlCall[],
      names: readonly string[],
      updates: Readonly<Record<string, string>>,
    ): FrozenDmlWriter {
      let counter = 0;
      return {
        ...makeWriter(calls),
        insert: vi.fn(
          async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
            calls.push({ op: 'insert', objectApiName, payload: records });
            return records.map((record) =>
              names.includes(String(record.Name))
                ? {
                    success: false,
                    errors: [`FIELD_CUSTOM_VALIDATION_EXCEPTION: ${String(record.Name)}`],
                  }
                : { id: `REAL-${objectApiName}-${++counter}`, success: true, errors: [] },
            );
          },
        ),
        update: vi.fn(
          async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
            calls.push({ op: 'update', objectApiName, payload: records });
            const error = updates[objectApiName];
            return records.map((record) =>
              error
                ? { id: String(record.Id), success: false, errors: [error] }
                : { id: String(record.Id), success: true, errors: [] },
            );
          },
        ),
      };
    }

    it('says of each cycle lookup whether its record, the one it points at, or the update was missing', async () => {
      // The Load tab tells a lookup left empty on a record the load wrote from
      // one that went with a record it did not write: the detail alone, in
      // English, could not be grouped by.
      const a = (n: number, b: number) => ({
        referenceId: `ObjA__c-00000${n}`,
        fields: { Name: `A${n}`, B__c: `ObjB__c-00000${b}` },
      });
      const dataset: FrozenDataset = {
        datasetVersion: '1.0.0',
        objects: [
          { objectApiName: 'ObjA__c', records: [a(1, 1), a(2, 2), a(3, 1)] },
          {
            objectApiName: 'ObjB__c',
            records: [
              { referenceId: 'ObjB__c-000001', fields: { Name: 'B1', A__c: 'ObjA__c-000001' } },
              { referenceId: 'ObjB__c-000002', fields: { Name: 'B2', A__c: 'ObjA__c-000002' } },
            ],
          },
        ],
        recordTypes: {},
        personContactSidecar: [],
      };
      const calls: DmlCall[] = [];
      const deps = makeDeps({
        dataset,
        writer: refusingWriter(calls, ['A3', 'B2'], {
          ObjA__c: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: B is locked',
        }),
      });

      const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

      expect(report.pass2).toEqual({
        resolved: 0,
        unresolved: [
          {
            objectApiName: 'ObjA__c',
            referenceId: 'ObjA__c-000002',
            field: 'B__c',
            cause: 'target-not-loaded',
            detail: 'referenced record ObjB__c-000002 was not loaded (skipped, failed or excluded)',
          },
          {
            objectApiName: 'ObjA__c',
            referenceId: 'ObjA__c-000003',
            field: 'B__c',
            cause: 'record-not-loaded',
            detail: 'child record was not loaded (see perObject failures/skips)',
          },
          {
            objectApiName: 'ObjA__c',
            referenceId: 'ObjA__c-000001',
            field: 'B__c',
            cause: 'update-refused',
            detail: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: B is locked',
          },
        ],
      });
      expect(report.status).toBe('completed-with-errors');
    });

    it('names the person account whose contact link the target refused, and why, and each link it could not resolve', async () => {
      // A refused update was reported under the sidecar entry of its index,
      // counted among every link, resolved or not: the first entry, whatever
      // it was, stood for the refused one.
      const records = (objectApiName: string, names: string[]) => ({
        objectApiName,
        records: names.map((name, i) => ({
          referenceId: `${objectApiName}-00000${i + 1}`,
          fields: objectApiName === 'Account' ? { Name: name } : { Name: name, LastName: name },
        })),
      });
      const link = (n: number) => ({
        accountReferenceId: `Account-00000${n}`,
        contactReferenceId: `Contact-00000${n}`,
      });
      const dataset: FrozenDataset = {
        datasetVersion: '1.0.0',
        objects: [records('Account', ['P1', 'P2', 'P3']), records('Contact', ['C1', 'C2', 'C3'])],
        recordTypes: {},
        personContactSidecar: [link(1), link(2), link(3)],
      };
      const calls: DmlCall[] = [];
      const deps = makeDeps({
        dataset,
        writer: refusingWriter(calls, ['P1', 'C2'], {
          Account:
            'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: PersonContactId',
        }),
      });

      const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

      expect(report.personContact).toEqual({
        restored: 0,
        unresolved: [
          {
            ...link(1),
            cause: 'record-not-loaded',
            detail: 'person account was not loaded (see perObject failures/skips)',
          },
          {
            ...link(2),
            cause: 'target-not-loaded',
            detail: 'contact Contact-000002 was not loaded (skipped, failed or excluded)',
          },
          {
            ...link(3),
            cause: 'update-refused',
            detail:
              'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: PersonContactId',
          },
        ],
      });
    });
  });
});

describe('FrozenDatasetLoader — reload without refresh', () => {
  /** The mapping of a load that created every record it names. */
  async function seedPreviousMapping(
    sasDir: string,
    entries: Record<string, string>,
  ): Promise<void> {
    const created = new Map<string, string[]>();
    for (const key of Object.keys(entries)) {
      const objectApiName = key.slice(0, key.lastIndexOf('-'));
      created.set(objectApiName, [...(created.get(objectApiName) ?? []), key]);
    }
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map(Object.entries(entries)),
      {
        created: [...created].map(([objectApiName, referenceIds]) => ({
          objectApiName,
          referenceIds,
        })),
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
      },
    );
  }

  it('never purges a record the last load linked: the target held it before any load', async () => {
    // The last load found an account the target held by its identity keys,
    // and wrote a contact under it. The dataset has changed since: the
    // account is no longer in it, and nothing matches it again.
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map([
        ['Account-000009', '001TARGETS-OWN'],
        ['Contact-000009', '003OLD-CONTACT'],
      ]),
      {
        created: [{ objectApiName: 'Contact', referenceIds: ['Contact-000009'] }],
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
      },
    );
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, sasDir, writer: makeWriter(calls) });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { reload: true }),
    );

    const deleted = calls.filter((c) => c.op === 'delete').flatMap((c) => c.payload as string[]);
    expect(deleted).toEqual(['003OLD-CONTACT']);
    expect(report.purge.deleted).toEqual({ Contact: 1 });
  });

  it('purges the record the last load created when its key now names another one', async () => {
    // The identity keys find another account under the key: the one the last
    // load created is a leftover, whichever key named it.
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, { 'Account-000001': '001OLD-ACCOUNT' });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeWriter(calls),
      config: { identityKeys: { Account: ['ExternalId__c'] } },
      queryImpl: async (_org, soql) =>
        soql.includes('ExternalId__c') ? [{ Id: '001TARGETS-OWN', ExternalId__c: 'ACC-1' }] : [],
    });

    await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { reload: true }));

    expect(calls.filter((c) => c.op === 'delete')).toEqual([
      { op: 'delete', objectApiName: 'Account', payload: ['001OLD-ACCOUNT'] },
    ]);
  });

  it('purges what the loads before the last one created, which no reload purged', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    const calls: DmlCall[] = [];
    // One writer: each load's records get ids of their own.
    const writer = makeWriter(calls);
    const deps = makeDeps({ dataset, sasDir, writer });
    const loader = new FrozenDatasetLoader(deps);
    await loader.load(makeOptions(deps, dataset));
    await loader.load(makeOptions(deps, dataset));
    calls.length = 0;

    const report = await loader.load(makeOptions(deps, dataset, { reload: true }));

    // Both loads' records, children first.
    expect(calls.filter((c) => c.op === 'delete')).toEqual([
      { op: 'delete', objectApiName: 'Contact', payload: ['REAL-Contact-4', 'REAL-Contact-2'] },
      { op: 'delete', objectApiName: 'Account', payload: ['REAL-Account-3', 'REAL-Account-1'] },
    ]);
    expect(report.purge.deleted).toEqual({ Contact: 2, Account: 2 });
    // Reloaded over, neither is kept.
    await expect(
      new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).recordedLoads(),
    ).resolves.toHaveLength(1);
  });

  it('keeps what the target refused to purge, for the next reload and for a removal', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, {
      'Account-000001': '001OLD-ACCOUNT',
      'Contact-000001': '003OLD-CONTACT',
    });
    const writer = makeWriter([]);
    writer.delete = vi.fn(async (_org: string, objectApiName: string, ids: string[]) =>
      ids.map((id) =>
        objectApiName === 'Account'
          ? { id, success: false, errors: ['DELETE_FAILED: it has opportunities'] }
          : { id, success: true, errors: [] },
      ),
    );
    const deps = makeDeps({ dataset, sasDir, writer });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { reload: true }),
    );

    expect(report.purge.failures).toEqual([
      {
        objectApiName: 'Account',
        recordId: '001OLD-ACCOUNT',
        errors: ['DELETE_FAILED: it has opportunities'],
      },
    ]);
    const loads = await new SasReferenceIdMappingStore(sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).recordedLoads();
    expect(loads).toHaveLength(2);
    expect(loads[1]).toMatchObject({
      earlier: true,
      mapping: new Map([['Account-000001', '001OLD-ACCOUNT']]),
      created: [{ objectApiName: 'Account', referenceIds: ['Account-000001'] }],
    });
  });

  it('keeps the loads before a pilot, whose reload purges nothing', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, {
      'Account-000001': '001OLD-ACCOUNT',
      'Contact-000001': '003OLD-CONTACT',
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeWriter(calls),
      config: { rootObjectApiName: 'Account' },
    });

    await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { reload: true, pilot: {} }),
    );

    expect(calls.filter((c) => c.op === 'delete')).toEqual([]);
    const loads = await new SasReferenceIdMappingStore(sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).recordedLoads();
    expect(loads[1]).toMatchObject({
      earlier: true,
      created: [
        { objectApiName: 'Account', referenceIds: ['Account-000001'] },
        { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
      ],
    });
  });

  describe('after a load recorded before loads kept what they created', () => {
    /** The mapping such a load wrote: which records it created, it does not say. */
    async function seedUnrecordedMapping(
      sasDir: string,
      entries: Record<string, string>,
    ): Promise<void> {
      await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
        new Map(Object.entries(entries)),
      );
    }

    const UNRECORDED = {
      'Account-000001': '001LOADED-OR-OWN',
      'Contact-000001': '003LOADED',
      'Pricebook2-000001': '01sSTANDARD',
      'Pricebook2-000002': '01sLOADED',
      'ProductSellingModel-000001': '0jPLOADED-OR-OWN',
      'ProductSellingModelOption-000001': '0iOLOADED-OR-OWN',
      'placeholder:Account:Contact.Mandatory_Lookup__c': '001PLACEHOLDER',
    };

    function depsFor(sasDir: string, calls: DmlCall[]) {
      return makeDeps({
        dataset: makeAccountContactDataset(),
        sasDir,
        writer: makeWriter(calls),
        config: { identityKeys: { Account: ['ExternalId__c'] } },
        queryImpl: async (_org, soql) =>
          soql.includes('IsStandard = true') ? [{ Id: '01sSTANDARD' }] : [],
      });
    }

    it('purges only what no load links, and says what it left in place', async () => {
      const sasDir = makeTmpDir();
      await seedUnrecordedMapping(sasDir, UNRECORDED);
      const calls: DmlCall[] = [];
      const deps = depsFor(sasDir, calls);
      const events: FrozenLoadProgressEvent[] = [];

      const report = await new FrozenDatasetLoader(deps).load(
        makeOptions(deps, makeAccountContactDataset(), {
          reload: true,
          onProgress: (event) => events.push(event),
        }),
      );

      // Never an account — the configuration gives accounts identity keys, so
      // a load may have found it in the target — nor a selling model, an
      // option or the standard price book. What no load links goes: a
      // contact, a price book, a placeholder.
      const deleted = calls.filter((c) => c.op === 'delete').flatMap((c) => c.payload as string[]);
      expect(deleted.sort()).toEqual(['001PLACEHOLDER', '003LOADED', '01sLOADED']);
      expect(report.purge.leftUnrecorded).toEqual({
        Account: 1,
        Pricebook2: 1,
        ProductSellingModel: 1,
        ProductSellingModelOption: 1,
      });
      expect(events.find((e) => e.phase === 'reload' && e.status === 'done')?.message).toContain(
        '4 record(s) left in place',
      );
    });

    it('judges its records once: the next reload finds none of them', async () => {
      const sasDir = makeTmpDir();
      await seedUnrecordedMapping(sasDir, UNRECORDED);
      const calls: DmlCall[] = [];
      const deps = depsFor(sasDir, calls);
      const loader = new FrozenDatasetLoader(deps);
      await loader.load(makeOptions(deps, makeAccountContactDataset(), { reload: true }));
      calls.length = 0;

      const report = await loader.load(
        makeOptions(deps, makeAccountContactDataset(), { reload: true }),
      );

      expect(report.purge.leftUnrecorded).toBeUndefined();
      // What the reload before it wrote, and nothing of the old load.
      expect(
        calls.filter((c) => c.op === 'delete').flatMap((c) => c.payload as string[]),
      ).not.toContain('003LOADED');
    });

    it('never purges on its word a record a later load says it linked', async () => {
      // The old load names a contact; the load after it — one that says what
      // it created — found that contact in the target and linked it.
      const sasDir = makeTmpDir();
      await seedUnrecordedMapping(sasDir, { 'Contact-000001': '003TARGETS-OWN' });
      const store = new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) });
      await store.persist(new Map([['Contact-000007', '003TARGETS-OWN']]), {
        created: [],
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
        earlier: { settled: [] },
      });
      const calls: DmlCall[] = [];
      const deps = depsFor(sasDir, calls);

      const report = await new FrozenDatasetLoader(deps).load(
        makeOptions(deps, makeAccountContactDataset(), { reload: true }),
      );

      expect(calls.filter((c) => c.op === 'delete')).toEqual([]);
      expect(report.purge.leftUnrecorded).toEqual({ Contact: 1 });
    });

    it('is kept by a load without Reload, for the next reload to purge', async () => {
      const sasDir = makeTmpDir();
      await seedUnrecordedMapping(sasDir, { 'Contact-000001': '003LOADED' });
      const calls: DmlCall[] = [];
      const deps = depsFor(sasDir, calls);
      const loader = new FrozenDatasetLoader(deps);
      await loader.load(makeOptions(deps, makeAccountContactDataset()));
      calls.length = 0;

      await loader.load(makeOptions(deps, makeAccountContactDataset(), { reload: true }));

      expect(
        calls.filter((c) => c.op === 'delete').flatMap((c) => c.payload as string[]),
      ).toContain('003LOADED');
    });
  });

  it('reuses reference records matched by identity keys instead of re-inserting', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, {
      'Account-000001': '001OLD-ACCOUNT',
      'Contact-000001': '003OLD-CONTACT',
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeWriter(calls),
      config: { identityKeys: { Account: ['ExternalId__c'] } },
      queryImpl: async (_org, soql) => {
        if (soql.includes('FROM Account')) {
          return [{ Id: '001OLD-ACCOUNT', ExternalId__c: 'ACC-1' }];
        }
        return [];
      },
    });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset, { reload: true }));

    // Account reused (no insert), Contact inserted pointing at the reused ID.
    expect(calls.some((c) => c.op === 'insert' && c.objectApiName === 'Account')).toBe(false);
    const contactInsert = calls.find((c) => c.op === 'insert' && c.objectApiName === 'Contact');
    expect((contactInsert?.payload as Array<Record<string, unknown>>)[0].AccountId).toBe(
      '001OLD-ACCOUNT',
    );
    expect(report.perObject.find((o) => o.objectApiName === 'Account')).toMatchObject({
      inserted: 0,
      reused: 1,
    });
    // The stale Contact mapping (not reused) was purged.
    expect(report.purge.deleted).toEqual({ Contact: 1 });
  });

  it('purges residuals CHILDREN BEFORE PARENTS (verified by call order)', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, {
      'Account-000001': '001OLD-ACCOUNT',
      'Contact-000001': '003OLD-CONTACT',
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, sasDir, writer: makeWriter(calls) }); // no identity keys → all residuals
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset, { reload: true }));

    const ops = calls.map((c) => `${c.op}:${c.objectApiName}`);
    // Contact (child) deleted before Account (parent) — lookups block parent deletion.
    expect(ops.indexOf('delete:Contact')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('delete:Contact')).toBeLessThan(ops.indexOf('delete:Account'));
    // Then fresh inserts, parents first.
    expect(ops.indexOf('insert:Account')).toBeLessThan(ops.indexOf('insert:Contact'));
    expect(ops.indexOf('delete:Account')).toBeLessThan(ops.indexOf('insert:Account'));
    expect(report.purge.deleted).toEqual({ Contact: 1, Account: 1 });
    // No duplicates: the mapping now points at the NEW ids only.
    const mapping = await new SasReferenceIdMappingStore(sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    expect(mapping.get('Account-000001')).toMatch(/^REAL-Account-/);
    expect(mapping.get('Contact-000001')).toMatch(/^REAL-Contact-/);
  });

  it('returns an activated order to a draft before deleting what the last load wrote', async () => {
    // The last load activated it; activated, neither it nor its products can
    // be deleted — "unable to modify activated order". An order still in
    // Draft is left as it is.
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, {
      'Order-000001': '801OLD-ORDER',
      'Order-000002': '801OLD-DRAFT',
      'OrderItem-000001': '802OLD-ITEM',
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeWriter(calls),
      queryImpl: async (_org, soql) => {
        if (soql.includes('FROM OrderStatus')) {
          return [
            { ApiName: 'ST001', StatusCode: 'Draft' },
            { ApiName: 'ST002', StatusCode: 'Activated' },
          ];
        }
        return soql.startsWith('SELECT Id, Status, LastModifiedDate FROM Order WHERE')
          ? [
              { Id: '801OLD-ORDER', Status: 'ST002', LastModifiedDate: '2026-09-23T10:00:05Z' },
              { Id: '801OLD-DRAFT', Status: 'ST001', LastModifiedDate: '2026-09-23T10:00:05Z' },
            ]
          : [];
      },
    });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset, { reload: true }));

    const ops = calls.map((c) => `${c.op}:${c.objectApiName}`);
    expect(ops.indexOf('update:Order')).toBeLessThan(ops.indexOf('delete:OrderItem'));
    expect(ops.indexOf('update:Order')).toBeLessThan(ops.indexOf('delete:Order'));
    expect(calls.filter((c) => c.op === 'update').map((c) => c.payload)).toEqual([
      [{ Id: '801OLD-ORDER', Status: 'ST001' }],
    ]);
    expect(report.purge.deleted).toMatchObject({ Order: 2, OrderItem: 1 });
  });

  it('deletes the custom prices of the last load before the standard ones', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, {
      'PricebookEntry-000001': '01uSTANDARD',
      'PricebookEntry-000002': '01uCUSTOM',
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeWriter(calls),
      queryImpl: async (_org, soql) =>
        soql.includes('Pricebook2.IsStandard = true') ? [{ Id: '01uSTANDARD' }] : [],
    });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset, { reload: true }));

    const deletes = calls.filter((c) => c.op === 'delete' && c.objectApiName === 'PricebookEntry');
    expect(deletes.map((c) => c.payload)).toEqual([['01uCUSTOM'], ['01uSTANDARD']]);
    expect(report.purge.deleted).toMatchObject({ PricebookEntry: 2 });
    // Told apart by the rule Forge's removal reads too, so a fix to it
    // reaches both: the purge used to carry a copy of it.
    expect(standardPriceIds).toHaveBeenCalledWith(expect.any(Function), [
      '01uSTANDARD',
      '01uCUSTOM',
    ]);
  });

  it('leaves a direct relation to go with its contact', async () => {
    // "A direct relationship cannot be deleted — delete the contact."
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, {
      'AccountContactRelation-000001': '07kDIRECT',
      'Contact-000001': '003OLD-CONTACT',
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeWriter(calls),
      queryImpl: async (_org, soql) =>
        soql.includes('IsDirect = true') && soql.includes("'07kDIRECT'")
          ? [{ Id: '07kDIRECT' }]
          : [],
    });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset, { reload: true }));

    const deleted = calls.filter((c) => c.op === 'delete').flatMap((c) => c.payload as string[]);
    expect(deleted).toEqual(['003OLD-CONTACT']);
    expect(report.purge.failures).toEqual([]);
  });

  it('counts a residual already deleted as purged', async () => {
    // A parent's deletion takes its cascading children with it; asked to
    // delete them a step later, the target answers ENTITY_IS_DELETED.
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, { 'Contact-000001': '003OLD-CONTACT' });
    const calls: DmlCall[] = [];
    const writer = makeWriter(calls);
    writer.delete = vi.fn(async (_org: string, _object: string, ids: string[]) =>
      ids.map((id) => ({ id, success: false, errors: ['ENTITY_IS_DELETED: entité supprimée'] })),
    );
    const deps = makeDeps({ dataset, sasDir, writer });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset, { reload: true }));

    expect(report.purge.failures).toEqual([]);
    expect(report.purge.deleted).toEqual({ Contact: 1 });
    expect(report.status).toBe('completed');
  });

  it('DEACTIVATES undeletable objects instead of deleting them', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedPreviousMapping(sasDir, {
      'Account-000001': '001OLD-ACCOUNT',
      'Contact-000001': '003OLD-CONTACT',
      'ServiceResource-000001': '0HnOLD-RESOURCE',
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeWriter(calls),
      config: { undeletableObjects: { ServiceResource: 'IsActive' } },
    });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset, { reload: true }));

    expect(calls.some((c) => c.op === 'delete' && c.objectApiName === 'ServiceResource')).toBe(
      false,
    );
    const deactivation = calls.find(
      (c) => c.op === 'update' && c.objectApiName === 'ServiceResource',
    );
    expect(deactivation?.payload).toEqual([{ Id: '0HnOLD-RESOURCE', IsActive: false }]);
    expect(report.purge.deactivated).toEqual({ ServiceResource: 1 });
  });
});

describe('FrozenDatasetLoader — pilot mode', () => {
  it('loads one root folder only: descendants plus needed referential', async () => {
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Account',
          records: [{ referenceId: 'Account-000001', fields: { Name: 'Shared Referential' } }],
        },
        {
          objectApiName: 'Contact',
          records: [
            {
              referenceId: 'Contact-000001',
              fields: { LastName: 'One', AccountId: 'Account-000001' },
            },
            {
              referenceId: 'Contact-000002',
              fields: { LastName: 'Two', AccountId: 'Account-000001' },
            },
          ],
        },
        {
          objectApiName: 'Case',
          records: [
            {
              referenceId: 'Case-000001',
              fields: { Subject: 'Root 1', ContactId: 'Contact-000001' },
            },
            {
              referenceId: 'Case-000002',
              fields: { Subject: 'Root 2', ContactId: 'Contact-000002' },
            },
          ],
        },
        {
          objectApiName: 'Asset',
          records: [
            {
              referenceId: 'Asset-000001',
              fields: { Name: 'Child of root 1', Case__c: 'Case-000001' },
            },
            {
              referenceId: 'Asset-000002',
              fields: { Name: 'Child of root 2', Case__c: 'Case-000002' },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      config: { rootObjectApiName: 'Case' },
    });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(
      makeOptions(deps, dataset, { pilot: { rootReferenceId: 'Case-000001' } }),
    );

    expect(report.mode.pilot).toBe(true);
    // Only folder 1: Case-000001, its descendant Asset-000001, and the
    // referential it needs (Contact-000001 → Account-000001). Folder 2 excluded.
    const insertedIds = calls
      .filter((c) => c.op === 'insert')
      .flatMap((c) =>
        (c.payload as Array<Record<string, unknown>>).map((r) => r.Subject ?? r.Name ?? r.LastName),
      );
    expect(insertedIds.sort()).toEqual(['Child of root 1', 'One', 'Root 1', 'Shared Referential']);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Case.fromFiles).toBe(1);
    expect(contract.objects.Contact.fromFiles).toBe(1);
    expect(contract.objects.Asset.fromFiles).toBe(1);
  });

  it("carries what the folder's prices need, which none of its records points at", async () => {
    // A line names its custom price. The standard price of its product under
    // its model, and the option that lets the product be sold under it, are
    // named by nothing: left out, the pilot sent its prices without either,
    // and the platform refuses such a price.
    const price = (referenceId: string, book: string, product: string, unitPrice: number) => ({
      referenceId,
      fields: {
        Pricebook2Id: book,
        Product2Id: product,
        ProductSellingModelId: 'ProductSellingModel-000001',
        UnitPrice: unitPrice,
      },
    });
    const option = (referenceId: string, product: string) => ({
      referenceId,
      fields: { Product2Id: product, ProductSellingModelId: 'ProductSellingModel-000001' },
    });
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Opportunity',
          records: [
            { referenceId: 'Opportunity-000001', fields: { Name: 'Pilot' } },
            { referenceId: 'Opportunity-000002', fields: { Name: 'Other' } },
          ],
        },
        {
          objectApiName: 'OpportunityLineItem',
          records: [
            {
              referenceId: 'OpportunityLineItem-000001',
              fields: {
                OpportunityId: 'Opportunity-000001',
                PricebookEntryId: 'PricebookEntry-000001',
              },
            },
            {
              referenceId: 'OpportunityLineItem-000002',
              fields: {
                OpportunityId: 'Opportunity-000002',
                PricebookEntryId: 'PricebookEntry-000002',
              },
            },
          ],
        },
        {
          objectApiName: 'Pricebook2',
          records: [
            { referenceId: 'Pricebook2-000001', fields: { Name: 'Resellers' } },
            { referenceId: 'Pricebook2-000002', fields: { Name: 'Standard' } },
          ],
        },
        {
          objectApiName: 'Product2',
          records: [
            { referenceId: 'Product2-000001', fields: { Name: 'Sold in the pilot' } },
            { referenceId: 'Product2-000002', fields: { Name: 'Sold elsewhere' } },
          ],
        },
        {
          objectApiName: 'ProductSellingModel',
          records: [
            {
              referenceId: 'ProductSellingModel-000001',
              fields: { Name: 'One-time', SellingModelType: 'OneTime' },
            },
          ],
        },
        {
          objectApiName: 'ProductSellingModelOption',
          records: [
            option('ProductSellingModelOption-000001', 'Product2-000001'),
            option('ProductSellingModelOption-000002', 'Product2-000002'),
          ],
        },
        {
          objectApiName: 'PricebookEntry',
          records: [
            price('PricebookEntry-000001', 'Pricebook2-000001', 'Product2-000001', 9),
            price('PricebookEntry-000002', 'Pricebook2-000001', 'Product2-000002', 19),
            price('PricebookEntry-000003', 'Pricebook2-000002', 'Product2-000001', 10),
            price('PricebookEntry-000004', 'Pricebook2-000002', 'Product2-000002', 20),
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
      standardPricebook: 'Pricebook2-000002',
    };
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      config: { rootObjectApiName: 'Opportunity' },
      queryImpl: async (_org, soql) =>
        soql.includes('IsStandard = true') ? [{ Id: '01sTARGETSTANDARD' }] : [],
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { pilot: { rootReferenceId: 'Opportunity-000001' } }),
    );

    const sent = (objectApiName: string) =>
      calls
        .filter((c) => c.op === 'insert' && c.objectApiName === objectApiName)
        .map((c) => c.payload as Array<Record<string, unknown>>);
    const mapping = await new SasReferenceIdMappingStore(deps.sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    const product = mapping.get('Product2-000001');
    const model = mapping.get('ProductSellingModel-000001');
    // The standard price first, in a call of its own, then the custom one.
    expect(sent('PricebookEntry')).toEqual([
      [
        {
          Pricebook2Id: '01sTARGETSTANDARD',
          Product2Id: product,
          ProductSellingModelId: model,
          UnitPrice: 10,
        },
      ],
      [
        {
          Pricebook2Id: mapping.get('Pricebook2-000001'),
          Product2Id: product,
          ProductSellingModelId: model,
          UnitPrice: 9,
        },
      ],
    ]);
    expect(sent('ProductSellingModelOption')).toEqual([
      [{ Product2Id: product, ProductSellingModelId: model }],
    ]);
    // The standard book is matched, never written; nothing of the other folder comes.
    expect(mapping.get('Pricebook2-000002')).toBe('01sTARGETSTANDARD');
    expect(sent('Pricebook2')).toEqual([[{ Name: 'Resellers' }]]);
    expect(sent('Product2')).toEqual([[{ Name: 'Sold in the pilot' }]]);
    expect(sent('Opportunity')).toEqual([[{ Name: 'Pilot' }]]);
    expect(report.perObject.find((o) => o.objectApiName === 'Pricebook2')).toMatchObject({
      fromFiles: 2,
      inserted: 1,
      reused: 1,
    });
    expect(report.status).toBe('completed');
  });

  it('requires a root object configuration for pilot mode', async () => {
    const dataset = makeAccountContactDataset();
    const deps = makeDeps({ dataset });
    const loader = new FrozenDatasetLoader(deps);
    await expect(loader.load(makeOptions(deps, dataset, { pilot: {} }))).rejects.toThrow(
      LoadConfigError,
    );
  });
});

describe('FrozenDatasetLoader — degraded mode (native anti-duplicate)', () => {
  it('skips and lists duplicate rejections — never an opaque error', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const writer = makeWriter(calls);
    writer.insert = vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'insert', objectApiName, payload: records });
        if (objectApiName === 'Contact') {
          return records.map(() => ({
            success: false,
            errors: [
              'DUPLICATE_VALUE: duplicate value found: Email duplicates value on record with id: 003xx',
            ],
          }));
        }
        return records.map(() => ({ id: `REAL-${objectApiName}-1`, success: true, errors: [] }));
      },
    );
    const deps = makeDeps({ dataset, writer });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    // Explicit degraded mode: skipped + listed, load still 'completed'.
    expect(report.status).toBe('completed');
    const contact = report.perObject.find((o) => o.objectApiName === 'Contact');
    expect(contact?.skippedDuplicates).toHaveLength(1);
    expect(contact?.skippedDuplicates[0].referenceId).toBe('Contact-000001');
    expect(contact?.failed).toEqual([]);
    // The skipped record is not in the mapping and is excluded from the contract.
    const mapping = await new SasReferenceIdMappingStore(deps.sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    expect(mapping.has('Contact-000001')).toBe(false);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Contact).toMatchObject({
      fromFiles: 1,
      excluded: 1,
      expected: 0,
      exclusionReasons: { 'duplicate-skipped': 1 },
    });
  });

  it('lists non-duplicate DML failures and marks the report completed-with-errors', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const writer = makeWriter(calls);
    writer.insert = vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'insert', objectApiName, payload: records });
        if (objectApiName === 'Contact') {
          return records.map(() => ({
            success: false,
            errors: ['REQUIRED_FIELD_MISSING: LastName'],
          }));
        }
        return records.map(() => ({ id: `REAL-${objectApiName}-1`, success: true, errors: [] }));
      },
    );
    const deps = makeDeps({ dataset, writer });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(report.status).toBe('completed-with-errors');
    expect(report.perObject.find((o) => o.objectApiName === 'Contact')?.failed).toHaveLength(1);
  });
});

describe('FrozenDatasetLoader — a cancel', () => {
  /** The mapping the load kept in the sas. */
  async function keptMapping(sasDir: string): Promise<Map<string, string>> {
    return new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).load();
  }

  it('writes no object after the cancel, and keeps the mapping of what it wrote', async () => {
    // A load read no cancel: once started, it purged, inserted and patched to
    // its end.
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const stop = new AbortController();
    const writer = makeWriter(calls);
    const insert = writer.insert;
    writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
      stop.abort();
      return insert(...args);
    });
    const deps = makeDeps({ dataset, writer });

    const error: unknown = await new FrozenDatasetLoader(deps)
      .load(makeOptions(deps, dataset, { signal: stop.signal }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FrozenLoadCancelledError);
    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual(['insert:Account']);
    // What it wrote is counted for the audit trail...
    expect((error as FrozenLoadCancelledError).written.perObject).toEqual([
      expect.objectContaining({ objectApiName: 'Account', inserted: 1 }),
    ]);
    // ...and kept where a reload looks for it.
    expect(await keptMapping(deps.sasDir)).toEqual(new Map([['Account-000001', 'REAL-Account-1']]));
  });

  it('keeps the residuals it had not purged yet when the cancel comes during a reload', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map([
        ['Account-000001', '001OLD-ACCOUNT'],
        ['Contact-000001', '003OLD-CONTACT'],
      ]),
    );
    const calls: DmlCall[] = [];
    const stop = new AbortController();
    const writer = makeWriter(calls);
    const remove = writer.delete;
    writer.delete = vi.fn(async (...args: Parameters<FrozenDmlWriter['delete']>) => {
      stop.abort();
      return remove(...args);
    });
    const deps = makeDeps({ dataset, sasDir, writer });

    await expect(
      new FrozenDatasetLoader(deps).load(
        makeOptions(deps, dataset, { reload: true, signal: stop.signal }),
      ),
    ).rejects.toBeInstanceOf(FrozenLoadCancelledError);

    // Contact purged, then the cancel: Account is neither purged nor inserted.
    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual(['delete:Contact']);
    // Kept as the load's own mapping alone, the Account the purge had not
    // reached would be known to no later reload. The next one purges it, and
    // not the contact again.
    calls.length = 0;
    const next = makeDeps({ dataset, sasDir, writer: makeWriter(calls) });
    await new FrozenDatasetLoader(next).load(makeOptions(next, dataset, { reload: true }));
    expect(calls.filter((c) => c.op === 'delete')).toEqual([
      { op: 'delete', objectApiName: 'Account', payload: ['001OLD-ACCOUNT'] },
    ]);
  });

  describe('that comes during the standard prices', () => {
    /** A product with a standard price and a custom one, in a book of resellers. */
    const prices: FrozenDataset = {
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
            {
              referenceId: 'PricebookEntry-000001',
              fields: {
                Pricebook2Id: 'Pricebook2-000001',
                Product2Id: 'Product2-000001',
                UnitPrice: 9,
              },
            },
            {
              referenceId: 'PricebookEntry-000002',
              fields: {
                Pricebook2Id: 'Pricebook2-000002',
                Product2Id: 'Product2-000001',
                UnitPrice: 10,
              },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
      standardPricebook: 'Pricebook2-000002',
    };

    /** Load `prices`, the load's cancel coming as the standard prices are written. */
    async function loadCancelledAtTheStandardPrices() {
      const calls: DmlCall[] = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const stop = new AbortController();
      const writer = makeWriter(calls);
      const insert = writer.insert;
      writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
        if (args[1] === 'PricebookEntry') stop.abort();
        return insert(...args);
      });
      const deps = makeDeps({
        dataset: prices,
        writer,
        queryImpl: async (_org, soql) =>
          soql.includes('IsStandard = true') ? [{ Id: '01sTARGETSTANDARD' }] : [],
      });
      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(
          makeOptions(deps, prices, {
            signal: stop.signal,
            onProgress: (e) => progress.push(e),
          }),
        )
        .catch((e: unknown) => e);
      return { error, calls, progress };
    }

    it('writes no custom price', async () => {
      // The two price writes had nothing between them to look at the cancel:
      // the custom prices were written after it.
      const { error, calls } = await loadCancelledAtTheStandardPrices();

      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      const sent = calls.filter((c) => c.objectApiName === 'PricebookEntry');
      expect(
        sent.map((c) => (c.payload as Array<Record<string, unknown>>)[0].Pricebook2Id),
      ).toEqual(['01sTARGETSTANDARD']);
      // The standard price it did write is counted for the audit trail, with
      // the custom one the cancel kept from the target.
      expect((error as FrozenLoadCancelledError).written.perObject).toContainEqual(
        expect.objectContaining({
          objectApiName: 'PricebookEntry',
          fromFiles: 2,
          inserted: 1,
          notInserted: 1,
        }),
      );
    });

    it('ends the object stopped, on a line that says what it wrote and what the cancel kept back', async () => {
      // Counted for the audit trail, the standard prices were said nowhere:
      // the object's last word was that it was inserting its rows. Ended
      // done, it then read as written whole.
      const { progress } = await loadCancelledAtTheStandardPrices();

      expect(
        progress
          .filter((e) => e.objectName === 'PricebookEntry' && e.status !== 'started')
          .map((e) => [e.status, e.message]),
      ).toEqual([
        [
          'stopped',
          'PricebookEntry: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, ' +
            '1 not inserted: the load was cancelled first',
        ],
      ]);
    });
  });

  it('names in its contract the load it counts, which a load it stopped is not', async () => {
    // Verified after a cancel, the stopped load's records were counted
    // against the contract of the load before it.
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    const guard = new SasPathGuard(repoRoot);
    const store = new SasReferenceIdMappingStore(sasDir, { guard });
    const ended = makeDeps({ dataset, sasDir });
    const report = await new FrozenDatasetLoader(ended).load(
      makeOptions(ended, dataset, { now: () => new Date('2026-09-24T10:00:00.000Z') }),
    );
    const counted = readCountingContract(guard, report.contractPath);
    expect(counted.loadStartedAt).toBe('2026-09-24T10:00:00.000Z');
    expect(contractCountsLoad(counted, (await store.recorded()) ?? { endedAt: '' })).toBe(true);

    const stop = new AbortController();
    const writer = makeWriter([]);
    const insert = writer.insert;
    writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
      stop.abort();
      return insert(...args);
    });
    const stopped = makeDeps({ dataset, sasDir, writer });
    await expect(
      new FrozenDatasetLoader(stopped).load(
        makeOptions(stopped, dataset, {
          signal: stop.signal,
          now: () => new Date('2026-09-24T11:00:00.000Z'),
        }),
      ),
    ).rejects.toBeInstanceOf(FrozenLoadCancelledError);

    const last = await store.recorded();
    expect(last?.startedAt).toBe('2026-09-24T11:00:00.000Z');
    expect(
      contractCountsLoad(readCountingContract(guard, report.contractPath), last ?? { endedAt: '' }),
    ).toBe(false);
  });

  it('keeps no mapping of its own when a reload is cancelled before it wrote anything', async () => {
    // Cancelled at its first purge, a reload kept a mapping of its own, with
    // nothing in it: the load before it read as an earlier one, and the last
    // load as one that stopped part way, which no verification would take.
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    const store = new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) });
    await store.persist(
      new Map([
        ['Account-000001', '001OLD-ACCOUNT'],
        ['Contact-000001', '003OLD-CONTACT'],
      ]),
      {
        created: [
          { objectApiName: 'Account', referenceIds: ['Account-000001'] },
          { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
        ],
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
      },
    );
    const before = fs.readFileSync(store.filePath, 'utf8');
    const stop = new AbortController();
    stop.abort();
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, sasDir, writer: makeWriter(calls) });

    const error: unknown = await new FrozenDatasetLoader(deps)
      .load(makeOptions(deps, dataset, { reload: true, signal: stop.signal }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FrozenLoadCancelledError);
    expect((error as Error).message).toBe(
      'The load was cancelled before it created or purged a record: the mapping is left as it was.',
    );
    expect(calls).toEqual([]);
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe(before);
  });

  it('keeps no mapping when a first load is cancelled before its first write', async () => {
    const dataset = makeAccountContactDataset();
    const stop = new AbortController();
    stop.abort();
    const deps = makeDeps({ dataset });

    await expect(
      new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { signal: stop.signal })),
    ).rejects.toBeInstanceOf(FrozenLoadCancelledError);

    expect(fs.existsSync(path.join(deps.sasDir, 'referenceid-mapping.json'))).toBe(false);
  });

  it('counts no object the target lacks when the cancel came before its turn', async () => {
    // The object comes first in the insert order, and was counted before the
    // insert pass looked at the cancel: its rows, never sent, went to the
    // audit trail as failed, and a load that wrote nothing as a failure.
    const dataset = makeAccountContactDataset();
    dataset.objects.unshift({
      objectApiName: 'Absence__c',
      records: [{ referenceId: 'Absence__c-000001', fields: { Name: 'Leave' } }],
    });
    const describes = describeFromDataset(dataset);
    delete describes['Absence__c'];
    const stop = new AbortController();
    stop.abort();
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, describes, writer: makeWriter(calls) });

    const error: unknown = await new FrozenDatasetLoader(deps)
      .load(makeOptions(deps, dataset, { signal: stop.signal }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FrozenLoadCancelledError);
    expect(calls).toEqual([]);
    expect((error as FrozenLoadCancelledError).written.perObject).toEqual([]);
  });

  it('still counts an object the target lacks when the load reached its turn before the cancel', async () => {
    // Its rows are lost with it at its turn, between the account and the
    // contact, as at the end of a load.
    const dataset = makeAccountContactDataset();
    dataset.objects.push({
      objectApiName: 'Branch__c',
      records: [
        {
          referenceId: 'Branch__c-000001',
          fields: { Name: 'North', Account__c: 'Account-000001' },
        },
      ],
    });
    const describes = describeFromDataset(dataset);
    delete describes['Branch__c'];
    const stop = new AbortController();
    const calls: DmlCall[] = [];
    const writer = makeWriter(calls);
    const insert = writer.insert;
    writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
      if (args[1] === 'Contact') stop.abort();
      return insert(...args);
    });
    const deps = makeDeps({ dataset, describes, writer });

    const error: unknown = await new FrozenDatasetLoader(deps)
      .load(makeOptions(deps, dataset, { signal: stop.signal }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FrozenLoadCancelledError);
    expect((error as FrozenLoadCancelledError).written.perObject).toEqual([
      expect.objectContaining({ objectApiName: 'Account', inserted: 1 }),
      expect.objectContaining({
        objectApiName: 'Branch__c',
        inserted: 0,
        failed: [expect.objectContaining({ referenceId: 'Branch__c-000001' })],
      }),
      expect.objectContaining({ objectApiName: 'Contact', inserted: 1 }),
    ]);
  });

  it('writes no contract over a load whose last pass the cancel came during', async () => {
    const dataset = {
      ...makeAccountContactDataset(),
      personContactSidecar: [
        { accountReferenceId: 'Account-000001', contactReferenceId: 'Contact-000001' },
      ],
    };
    const stop = new AbortController();
    const writer = makeWriter([]);
    writer.update = vi.fn(async () => {
      // The PersonContact upload is the one the cancel aborts: nothing written.
      stop.abort();
      return [];
    });
    const deps = makeDeps({ dataset, writer });

    await expect(
      new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { signal: stop.signal })),
    ).rejects.toBeInstanceOf(FrozenLoadCancelledError);

    expect(writer.update).toHaveBeenCalledTimes(1);
    // A contract would count the links as restored.
    expect(fs.existsSync(path.join(deps.sasDir, 'counting-contract.json'))).toBe(false);
  });

  describe('through the writer a load writes with', () => {
    /**
     * The bulk writer a load gets, bound to its cancel, over a target that
     * takes every row it is sent but the ones `calls.refuses` names; `sent`
     * gets each call's rows as they go. `calls.batchSize` rows go in a call,
     * and the cancel comes as the first call of `calls.cancelsAt` is answered.
     */
    function bulkWriterTo(
      stop: AbortController,
      sent: Array<{ objectApiName: string; rows: unknown[] }>,
      calls: {
        batchSize?: number;
        cancelsAt?: string;
        refuses?: (row: Record<string, unknown>) => boolean;
      } = {},
    ): FrozenDmlWriter {
      let counter = 0;
      const sobject = (objectApiName: string) => ({
        create: async (rows: Array<Record<string, unknown>>) => {
          sent.push({ objectApiName, rows });
          if (objectApiName === calls.cancelsAt) stop.abort();
          return rows.map((row) =>
            calls.refuses?.(row)
              ? {
                  success: false,
                  errors: [
                    { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Name refused' },
                  ],
                }
              : { success: true, id: `REAL-${objectApiName}-${++counter}` },
          );
        },
      });
      return createBulkDmlWriter(
        new BulkDataWriter({
          connection: { sobject } as unknown as Connection,
          bulkExecutor: new BulkApiExecutor(200),
          bulkManager: new BulkApiManager(),
          retryConfig: { maxRetries: 0, initialDelay: 0, jitter: false },
          signal: stop.signal,
          onProgress: () => undefined,
          log: () => undefined,
        }),
        calls.batchSize,
      );
    }

    /** Three accounts and a contact: the accounts go in two calls of two. */
    function threeAccounts(): FrozenDataset {
      const dataset = makeAccountContactDataset();
      dataset.objects[0].records.push(
        { referenceId: 'Account-000002', fields: { Name: 'Second', ExternalId__c: 'ACC-2' } },
        { referenceId: 'Account-000003', fields: { Name: 'Third', ExternalId__c: 'ACC-3' } },
      );
      return dataset;
    }

    /** The lines that end `objectApiName`, as the load said them. */
    const endsOf = (progress: readonly FrozenLoadProgressEvent[], objectApiName: string) =>
      progress
        .filter((e) => e.objectName === objectApiName && e.status !== 'started')
        .map((e) => [e.status, e.message]);

    it('ends an object the cancel cut short between two calls stopped, on a line that says what the cancel kept back', async () => {
      // The writer stops before its next call and hands back what the calls
      // before it wrote. The object's line said what they inserted, and ended
      // done: the row the cancel kept from the target was said nowhere, nor
      // counted in what the load wrote.
      const dataset = threeAccounts();
      const stop = new AbortController();
      const sent: Array<{ objectApiName: string; rows: unknown[] }> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const deps = makeDeps({
        dataset,
        writer: bulkWriterTo(stop, sent, { batchSize: 2, cancelsAt: 'Account' }),
      });

      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(
          makeOptions(deps, dataset, { signal: stop.signal, onProgress: (e) => progress.push(e) }),
        )
        .catch((e: unknown) => e);

      expect(sent.map((s) => [s.objectApiName, s.rows.length])).toEqual([['Account', 2]]);
      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect(endsOf(progress, 'Account')).toEqual([
        [
          'stopped',
          'Account: 2 inserted, 0 reused, 0 duplicates skipped, 0 failed, ' +
            '1 not inserted: the load was cancelled first',
        ],
      ]);
      expect((error as FrozenLoadCancelledError).written.perObject).toEqual([
        {
          objectApiName: 'Account',
          fromFiles: 3,
          inserted: 2,
          reused: 0,
          skippedDuplicates: [],
          failed: [],
          notInserted: 1,
        },
      ]);
    });

    it('ends an object the cancel cut short as a failure when the target refused a row of it', async () => {
      // What there is to act on is the refusal; the line still says what the
      // cancel kept back.
      const dataset = threeAccounts();
      const stop = new AbortController();
      const sent: Array<{ objectApiName: string; rows: unknown[] }> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const deps = makeDeps({
        dataset,
        writer: bulkWriterTo(stop, sent, {
          batchSize: 2,
          cancelsAt: 'Account',
          refuses: (row) => row.Name === 'Second',
        }),
      });

      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(
          makeOptions(deps, dataset, { signal: stop.signal, onProgress: (e) => progress.push(e) }),
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect(endsOf(progress, 'Account')).toEqual([
        [
          'error',
          'Account: 1 inserted, 0 reused, 0 duplicates skipped, 1 failed, ' +
            '1 not inserted: the load was cancelled first',
        ],
      ]);
      expect((error as FrozenLoadCancelledError).written.perObject).toEqual([
        expect.objectContaining({
          objectApiName: 'Account',
          inserted: 1,
          failed: [expect.objectContaining({ referenceId: 'Account-000002' })],
          notInserted: 1,
        }),
      ]);
    });

    it('ends an object whose every call went out before the cancel as it would have', async () => {
      // The cancel came as its last call was answered: nothing of it was kept
      // back, and the load stops before the next object.
      const dataset = makeAccountContactDataset();
      const stop = new AbortController();
      const sent: Array<{ objectApiName: string; rows: unknown[] }> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const deps = makeDeps({
        dataset,
        writer: bulkWriterTo(stop, sent, { batchSize: 2, cancelsAt: 'Account' }),
      });

      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(
          makeOptions(deps, dataset, { signal: stop.signal, onProgress: (e) => progress.push(e) }),
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect(endsOf(progress, 'Account')).toEqual([
        ['done', 'Account: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed'],
      ]);
      expect((error as FrozenLoadCancelledError).written.perObject).toEqual([
        {
          objectApiName: 'Account',
          fromFiles: 1,
          inserted: 1,
          reused: 0,
          skippedDuplicates: [],
          failed: [],
        },
      ]);
    });

    /** Production Guard, the load's cancel coming as it judges the first insert of `objectApiName`. */
    function guardCancellingAt(stop: AbortController, objectApiName: string): ProductionGuard {
      const guard = new ProductionGuard();
      const check = guard.check.bind(guard);
      vi.spyOn(guard, 'check').mockImplementation((request: OperationRequest) => {
        if (request.operation === 'insert' && request.objectName === objectApiName) stop.abort();
        return check(request);
      });
      return guard;
    }

    it('sends none of an object the cancel came before as its insert was judged', async () => {
      // The last check of the cancel is the object's, before its guard: the
      // writer sent the first batch of a write the cancel had come before.
      const dataset = makeAccountContactDataset();
      const stop = new AbortController();
      const sent: Array<{ objectApiName: string; rows: unknown[] }> = [];
      const deps = makeDeps({
        dataset,
        writer: bulkWriterTo(stop, sent),
        guard: guardCancellingAt(stop, 'Contact'),
      });

      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(makeOptions(deps, dataset, { signal: stop.signal }))
        .catch((e: unknown) => e);

      expect(sent.map((s) => s.objectApiName)).toEqual(['Account']);
      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect((error as FrozenLoadCancelledError).written.perObject).toEqual([
        expect.objectContaining({ objectApiName: 'Account', inserted: 1 }),
        expect.objectContaining({ objectApiName: 'Contact', inserted: 0, failed: [] }),
      ]);
      expect(await keptMapping(deps.sasDir)).toEqual(
        new Map([['Account-000001', 'REAL-Account-1']]),
      );
    });

    it('creates no placeholder the cancel came before, and ends cancelled rather than failed', async () => {
      // The placeholder went in after the cancel. Kept from the target, it is
      // answered for by nothing, and read as a refusal the load would end as
      // a failure over a record it never sent.
      const dataset = makeAccountContactDataset();
      const stop = new AbortController();
      const sent: Array<{ objectApiName: string; rows: unknown[] }> = [];
      const deps = makeDeps({
        dataset,
        describes: describeFromDataset(dataset, {
          Contact: [
            field({
              name: 'Mandatory_Lookup__c',
              type: 'reference',
              nillable: false,
              referenceTo: ['Account'],
            }),
          ],
        }),
        writer: bulkWriterTo(stop, sent),
        guard: guardCancellingAt(stop, 'Account'),
        config: {
          requiredLookupPlaceholders: {
            'Contact.Mandatory_Lookup__c': { name: 'TECH_PLACEHOLDER_DO_NOT_USE' },
          },
        },
      });

      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(makeOptions(deps, dataset, { signal: stop.signal }))
        .catch((e: unknown) => e);

      expect(sent).toEqual([]);
      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect((error as FrozenLoadCancelledError).written.placeholders).toEqual([]);
      expect(fs.existsSync(path.join(deps.sasDir, 'referenceid-mapping.json'))).toBe(false);
    });
  });
});

describe('FrozenDatasetLoader — a load that fails part way', () => {
  // Kept only at its end and at a cancel, the mapping of a load that failed
  // part way named nothing it had written: no reload purged it, no removal
  // could take it back, and the next load did not know it.

  /** The loads the sas records, the last first, as a removal and a reload read them. */
  const recordedLoads = (sasDir: string) =>
    new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).recordedLoads();

  /** What a removal would take next, per object, as its confirmation lists it. */
  async function removalPlan(sasDir: string) {
    const load = loadToRemove(await recordedLoads(sasDir));
    return load ? loadCreatedRecords(load) : [];
  }

  /** Key prefixes of the ids the writer below answers with. */
  const KEY_PREFIX: Record<string, string> = {
    Account: '001',
    Contact: '003',
    Order: '801',
    OrderItem: '802',
    Pricebook2: '01s',
    PricebookEntry: '01u',
    Product2: '01t',
    ObjA__c: 'a00',
    ObjB__c: 'a01',
  };

  /**
   * Writer mock whose inserts answer with record ids — fifteen letters and
   * digits, the only ids a removal takes — numbered in the order written.
   */
  function makeIdWriter(calls: DmlCall[]): FrozenDmlWriter {
    const writer = makeWriter(calls);
    let counter = 0;
    writer.insert = vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'insert', objectApiName, payload: records });
        return records.map(() => ({
          id: `${KEY_PREFIX[objectApiName]}${String(++counter).padStart(12, '0')}`,
          success: true,
          errors: [],
        }));
      },
    );
    return writer;
  }

  /** Production Guard refusing the writes `refuses` picks, and judging the others as it does. */
  function refusingGuard(refuses: (request: OperationRequest) => boolean): ProductionGuard {
    const guard = new ProductionGuard();
    const judge = guard.check.bind(guard);
    vi.spyOn(guard, 'check').mockImplementation((request) =>
      refuses(request)
        ? {
            allowed: false,
            requiresConfirmation: false,
            requiresApproval: false,
            blockedReason: 'not on this org',
            warnings: [],
            impactSummary: '',
          }
        : judge(request),
    );
    return guard;
  }

  /** What a load ended with, thrown or returned. */
  const failureOf = (load: Promise<unknown>): Promise<unknown> => load.catch((e: unknown) => e);

  const OLD_ACCOUNT = '001OLDACCOUNT01';
  const OLD_CONTACT = '003OLDCONTACT01';

  /** The mapping of an earlier load that created an account and a contact. */
  async function seedEarlierLoad(sasDir: string): Promise<void> {
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map([
        ['Account-000001', OLD_ACCOUNT],
        ['Contact-000001', OLD_CONTACT],
      ]),
      {
        created: [
          { objectApiName: 'Account', referenceIds: ['Account-000001'] },
          { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
        ],
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
      },
    );
  }

  it('keeps what it wrote when Production Guard refuses a batch after others went through', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeIdWriter(calls),
      guard: refusingGuard((request) => request.objectName === 'Contact'),
    });

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect((error as Error).cause).toBeInstanceOf(LoadGuardError);
    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual(['insert:Account']);
    const [load] = await recordedLoads(deps.sasDir);
    expect(load.mapping.get('Account-000001')).toBe('001000000000001');
    expect(load.created).toEqual([{ objectApiName: 'Account', referenceIds: ['Account-000001'] }]);
    expect(await removalPlan(deps.sasDir)).toEqual([
      { objectApiName: 'Account', ids: ['001000000000001'] },
    ]);
    // The report says the load failed, why, and what it left.
    const message = (error as Error).message;
    expect(message).toMatch(/^Production guard refused insert on Contact: not on this org\n/);
    expect(message).toContain('The load failed after it had created 1 record(s) (Account: 1).');
    expect((error as FrozenLoadFailedError).written.perObject).toEqual([
      expect.objectContaining({ objectApiName: 'Account', inserted: 1 }),
    ]);
  });

  it('keeps the placeholder it made when the target refuses the next one', async () => {
    const dataset = makeAccountContactDataset();
    const describes = describeFromDataset(dataset, {
      Contact: [
        field({
          name: 'Mandatory_Lookup__c',
          type: 'reference',
          nillable: false,
          referenceTo: ['Account'],
        }),
        field({
          name: 'Second_Lookup__c',
          type: 'reference',
          nillable: false,
          referenceTo: ['Account'],
        }),
      ],
    });
    const calls: DmlCall[] = [];
    const writer = makeIdWriter(calls);
    const insert = writer.insert;
    let inserts = 0;
    writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) =>
      ++inserts === 2
        ? [{ success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no technical record'] }]
        : insert(...args),
    );
    const deps = makeDeps({
      dataset,
      describes,
      writer,
      config: {
        requiredLookupPlaceholders: {
          'Contact.Mandatory_Lookup__c': { name: 'TECH_PLACEHOLDER_ONE' },
          'Contact.Second_Lookup__c': { name: 'TECH_PLACEHOLDER_TWO' },
        },
      },
    });

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect((error as Error).cause).toBeInstanceOf(LoadConfigError);
    expect((error as Error).message).toContain(
      'Placeholder insert failed for required lookup Contact.Second_Lookup__c',
    );
    const [load] = await recordedLoads(deps.sasDir);
    expect(load.created).toEqual([
      {
        objectApiName: 'Account',
        referenceIds: ['placeholder:Account:Contact.Mandatory_Lookup__c'],
      },
    ]);
    expect(await removalPlan(deps.sasDir)).toEqual([
      { objectApiName: 'Account', ids: ['001000000000001'] },
    ]);
  });

  it('keeps what it wrote when a write throws part way, and the next reload purges it', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const writer = makeIdWriter(calls);
    const insert = writer.insert;
    writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
      if (args[1] === 'Contact') throw new Error('Bulk job failed: the connection was reset');
      return insert(...args);
    });
    const deps = makeDeps({ dataset, writer });

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect((error as Error).message).toMatch(/^Bulk job failed: the connection was reset\n/);
    expect((await recordedLoads(deps.sasDir))[0].created).toEqual([
      { objectApiName: 'Account', referenceIds: ['Account-000001'] },
    ]);
    expect(await removalPlan(deps.sasDir)).toEqual([
      { objectApiName: 'Account', ids: ['001000000000001'] },
    ]);
    // The next reload knows it, and purges it.
    calls.length = 0;
    const next = makeDeps({ dataset, sasDir: deps.sasDir, writer: makeWriter(calls) });
    await new FrozenDatasetLoader(next).load(makeOptions(next, dataset, { reload: true }));
    expect(calls.filter((c) => c.op === 'delete')).toEqual([
      { op: 'delete', objectApiName: 'Account', payload: ['001000000000001'] },
    ]);
  });

  it('counts and keeps the standard prices it wrote when the custom prices throw', async () => {
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
            {
              referenceId: 'PricebookEntry-000001',
              fields: { Pricebook2Id: 'Pricebook2-000001', Product2Id: 'Product2-000001' },
            },
            {
              referenceId: 'PricebookEntry-000002',
              fields: { Pricebook2Id: 'Pricebook2-000002', Product2Id: 'Product2-000001' },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
      standardPricebook: 'Pricebook2-000002',
    };
    const calls: DmlCall[] = [];
    const writer = makeIdWriter(calls);
    const insert = writer.insert;
    let prices = 0;
    writer.insert = vi.fn(async (...args: Parameters<FrozenDmlWriter['insert']>) => {
      if (args[1] === 'PricebookEntry' && ++prices === 2) {
        throw new Error('UNKNOWN_EXCEPTION: An unexpected error occurred');
      }
      return insert(...args);
    });
    const deps = makeDeps({
      dataset,
      writer,
      queryImpl: async (_org, soql) =>
        soql.includes('IsStandard = true') ? [{ Id: '01s000000000STD' }] : [],
    });

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    // The standard price is in the target: counted for the audit trail and
    // in what the report says the load left.
    expect((error as FrozenLoadFailedError).written.perObject).toContainEqual(
      expect.objectContaining({ objectApiName: 'PricebookEntry', fromFiles: 2, inserted: 1 }),
    );
    expect((error as Error).message).toContain(
      'created 3 record(s) (Pricebook2: 1, Product2: 1, PricebookEntry: 1)',
    );
    // Named in the mapping, and taken by a removal; the standard book it
    // matched never is.
    expect((await recordedLoads(deps.sasDir))[0].created).toEqual([
      { objectApiName: 'Pricebook2', referenceIds: ['Pricebook2-000001'] },
      { objectApiName: 'Product2', referenceIds: ['Product2-000001'] },
      { objectApiName: 'PricebookEntry', referenceIds: ['PricebookEntry-000002'] },
    ]);
    expect(await removalPlan(deps.sasDir)).toEqual([
      { objectApiName: 'PricebookEntry', ids: ['01u000000000003'] },
      { objectApiName: 'Product2', ids: ['01t000000000002'] },
      { objectApiName: 'Pricebook2', ids: ['01s000000000001'] },
    ]);
  });

  it('keeps what it wrote when the patch of a cycle throws', async () => {
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'ObjA__c',
          records: [
            { referenceId: 'ObjA__c-000001', fields: { Name: 'A', B__c: 'ObjB__c-000001' } },
          ],
        },
        {
          objectApiName: 'ObjB__c',
          records: [
            { referenceId: 'ObjB__c-000001', fields: { Name: 'B', A__c: 'ObjA__c-000001' } },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
    const writer = makeIdWriter([]);
    writer.update = vi.fn(async () => {
      throw new Error('UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record');
    });
    const deps = makeDeps({ dataset, writer });

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect(writer.update).toHaveBeenCalledTimes(1);
    expect((await recordedLoads(deps.sasDir))[0].created).toEqual([
      { objectApiName: 'ObjA__c', referenceIds: ['ObjA__c-000001'] },
      { objectApiName: 'ObjB__c', referenceIds: ['ObjB__c-000001'] },
    ]);
    expect(await removalPlan(deps.sasDir)).toEqual([
      { objectApiName: 'ObjB__c', ids: ['a01000000000002'] },
      { objectApiName: 'ObjA__c', ids: ['a00000000000001'] },
    ]);
  });

  it('keeps what it wrote when the statuses set aside at insert throw', async () => {
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Order',
          records: [{ referenceId: 'Order-000001', fields: { Status: 'ST002' } }],
        },
        {
          objectApiName: 'OrderItem',
          records: [
            { referenceId: 'OrderItem-000001', fields: { OrderId: 'Order-000001', Quantity: 2 } },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
    const writer = makeIdWriter([]);
    writer.update = vi.fn(async () => {
      throw new Error('REQUEST_RUNNING_TOO_LONG: Your request was running for too long');
    });
    const deps = makeDeps({
      dataset,
      writer,
      queryImpl: async (_org, soql) =>
        soql.includes('FROM OrderStatus')
          ? [
              { ApiName: 'ST002', StatusCode: 'Activated' },
              { ApiName: 'ST001', StatusCode: 'Draft' },
            ]
          : [],
    });

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect(writer.update).toHaveBeenCalledWith('00D-target', 'Order', [
      { Id: '801000000000001', Status: 'ST002' },
    ]);
    expect((await recordedLoads(deps.sasDir))[0].created).toEqual([
      { objectApiName: 'Order', referenceIds: ['Order-000001'] },
      { objectApiName: 'OrderItem', referenceIds: ['OrderItem-000001'] },
    ]);
    expect(await removalPlan(deps.sasDir)).toEqual([
      { objectApiName: 'OrderItem', ids: ['802000000000002'] },
      { objectApiName: 'Order', ids: ['801000000000001'] },
    ]);
  });

  it('keeps what it wrote when the PersonContact pass throws', async () => {
    const dataset = {
      ...makeAccountContactDataset(),
      personContactSidecar: [
        { accountReferenceId: 'Account-000001', contactReferenceId: 'Contact-000001' },
      ],
    };
    const writer = makeIdWriter([]);
    writer.update = vi.fn(async () => {
      throw new Error('INVALID_SESSION_ID: Session expired or invalid');
    });
    const deps = makeDeps({ dataset, writer });

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect((error as Error).message).toContain('created 2 record(s) (Account: 1, Contact: 1)');
    expect(await removalPlan(deps.sasDir)).toEqual([
      { objectApiName: 'Contact', ids: ['003000000000002'] },
      { objectApiName: 'Account', ids: ['001000000000001'] },
    ]);
    // Nor is a contract written over it: the links it counts were never restored.
    expect(fs.existsSync(path.join(deps.sasDir, 'counting-contract.json'))).toBe(false);
  });

  it('keeps what the purge left of the earlier load when Production Guard refuses it part way', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedEarlierLoad(sasDir);
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeIdWriter(calls),
      guard: refusingGuard(
        (request) => request.operation === 'delete' && request.objectName === 'Account',
      ),
    });

    const error = await failureOf(
      new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { reload: true })),
    );

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual(['delete:Contact']);
    expect((error as Error).message).toContain(
      'The load failed after it had purged 1 record(s) that earlier loads created.',
    );
    // The contact it purged is named nowhere any more; the account it did
    // not reach is still the earlier load's, and the removal takes it alone.
    const loads = await recordedLoads(sasDir);
    expect(loads.map((load) => [...load.mapping.values()])).toEqual([[], [OLD_ACCOUNT]]);
    expect(await removalPlan(sasDir)).toEqual([{ objectApiName: 'Account', ids: [OLD_ACCOUNT] }]);
  });

  it('refuses a reload whose configuration leaves a required field uncovered before it purges anything', async () => {
    // The purge came first: refused for a default nobody had declared, the
    // reload had already deleted what the load before it created, for a load
    // that wrote no record of the dataset.
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedEarlierLoad(sasDir);
    const file = path.join(sasDir, 'referenceid-mapping.json');
    const before = fs.readFileSync(file, 'utf8');
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeIdWriter(calls),
      describes: describeFromDataset(dataset, {
        Contact: [field({ name: 'Region__c', nillable: false })],
      }),
    });

    const error = await failureOf(
      new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { reload: true })),
    );

    expect(error).toBeInstanceOf(LoadConfigError);
    const message = (error as Error).message;
    expect(message).toContain('requiredFieldDefaults["Contact.Region__c"]');
    expect(message).toContain('Nothing was written.');
    expect(calls).toEqual([]);
    // The load before it is as it was: its removal, or the next reload, still takes both.
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(await removalPlan(sasDir)).toEqual([
      { objectApiName: 'Contact', ids: [OLD_CONTACT] },
      { objectApiName: 'Account', ids: [OLD_ACCOUNT] },
    ]);
  });

  it('keeps its mapping once when what fails comes after it was kept', async () => {
    // The counting contract is written after the mapping. Kept a second time,
    // the load would be one of the loads before it too, offered for removal
    // twice.
    const dataset = makeAccountContactDataset();
    const deps = makeDeps({ dataset, writer: makeIdWriter([]) });
    fs.mkdirSync(path.join(deps.sasDir, 'counting-contract.json'));

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect((error as Error).cause).toMatchObject({ code: 'EISDIR' });
    expect(await recordedLoads(deps.sasDir)).toHaveLength(1);
    expect(await removalPlan(deps.sasDir)).toEqual([
      { objectApiName: 'Contact', ids: ['003000000000002'] },
      { objectApiName: 'Account', ids: ['001000000000001'] },
    ]);
  });

  it('says so when the mapping that would name what it wrote cannot be written', async () => {
    const dataset = makeAccountContactDataset();
    const deps = makeDeps({
      dataset,
      writer: makeIdWriter([]),
      guard: refusingGuard((request) => request.objectName === 'Contact'),
    });
    vi.spyOn(deps.mappingStore, 'persist').mockRejectedValue(
      new Error('ENOSPC: no space left on device'),
    );

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect((error as FrozenLoadFailedError).mappingKept).toBe(false);
    const message = (error as Error).message;
    expect(message).toMatch(/^Production guard refused insert on Contact/);
    expect(message).toContain(
      'The mapping could not be written, and nothing names what it created — no removal or ' +
        'reload will find it: ENOSPC: no space left on device',
    );
  });

  it('leaves the mapping as it was, and ends on what it failed on, when it failed before writing', async () => {
    const dataset = makeAccountContactDataset();
    const sasDir = makeTmpDir();
    await seedEarlierLoad(sasDir);
    const file = path.join(sasDir, 'referenceid-mapping.json');
    const before = fs.readFileSync(file, 'utf8');
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: makeIdWriter(calls),
      guard: refusingGuard((request) => request.objectName === 'Account'),
    });

    const error = await failureOf(new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset)));

    expect(error).toBeInstanceOf(LoadGuardError);
    expect(calls).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('FrozenDatasetLoader — the orders a reload set to Draft for deletes that did not come', () => {
  // An activated order is set to Draft before the purge deletes it. Stopped
  // between the two, a reload left the order deactivated, and the load that
  // created it named with an order modified after it: that load's removal
  // kept the order as changed since.

  /** The user the session to the target writes as, and someone else. */
  const USER = '005000000000001AAA';
  const COLLEAGUE = '005000000000002AAA';
  const ORDER = '801000000000001AAA';
  const OTHER_ORDER = '801000000000002AAA';
  const ITEM = '802000000000001AAA';
  /** The target's dates of what the earlier load wrote: its order, activated last. */
  const LOADED = { first: '2026-09-23T10:00:01.000Z', last: '2026-09-23T10:00:05.000Z' };
  const AT_LOAD = '2026-09-23T10:00:05.000+0000';

  type Row = Record<string, unknown> & { Id: string };

  /**
   * The target in memory, as the reload and a removal both reach it: the
   * statuses an order goes through, the earlier load's activated order and
   * its item, a write dated by the org's clock as the running user, a delete
   * that takes an order's items along — and that an activated order, or an
   * item of one, is refused — and what `refuse` refuses besides.
   */
  class OrderTarget {
    readonly rows = new Map<string, Row[]>([
      [
        'OrderStatus',
        [
          { Id: 'status-1', ApiName: 'ST001', StatusCode: 'Draft' },
          { Id: 'status-2', ApiName: 'ST002', StatusCode: 'Activated' },
        ],
      ],
      ['Order', [this.loaded(ORDER, { Status: 'ST002' })]],
      ['OrderItem', [this.loaded(ITEM, { OrderId: ORDER })]],
    ]);
    /** A write the target refuses, with its error. */
    refuse?: (
      operation: 'update' | 'delete',
      object: string,
      record: Record<string, unknown>,
    ) => string | undefined;
    private tick = 0;
    private inserted = 0;

    /** A record the earlier load created, as it left it. */
    loaded(id: string, fields: Record<string, unknown>): Row {
      return {
        Id: id,
        CreatedDate: AT_LOAD,
        LastModifiedDate: AT_LOAD,
        CreatedById: USER,
        LastModifiedById: USER,
        ...fields,
      };
    }

    /** The org's clock: a second on at every reading. */
    now(): string {
      return new Date(Date.parse('2026-09-24T12:00:00.000Z') + 1_000 * ++this.tick).toISOString();
    }

    row(object: string, id: string): Row | undefined {
      return (this.rows.get(object) ?? []).find((row) => row.Id === id);
    }

    /** What a query of the shapes the loader and the removal send answers. */
    select(soql: string): Row[] {
      const match = /^SELECT (.+?) FROM (\w+)(?: WHERE (\w+) IN \((.*?)\))?(?: LIMIT \d+)?$/.exec(
        soql,
      );
      if (!match) return [];
      const [, columns, object, field, list] = match;
      const wanted = list?.split(', ').map((quoted) => quoted.slice(1, -1));
      return (this.rows.get(object) ?? [])
        .filter((row) => !wanted || wanted.includes(String(row[field])))
        .map((row) => ({
          Id: row.Id,
          ...Object.fromEntries(columns.split(', ').map((c) => [c, row[c]])),
        }));
    }

    private activated(order: Row | undefined): boolean {
      return order?.Status === 'ST002';
    }

    update(object: string, records: Array<Record<string, unknown>>): OperationOutcome[] {
      return records.map((record) => {
        const id = String(record.Id);
        const row = this.row(object, id);
        if (!row) return { id, success: false, errors: ['ENTITY_IS_DELETED: entity is deleted'] };
        const refusal = this.refuse?.('update', object, record);
        if (refusal) return { id, success: false, errors: [refusal] };
        Object.assign(row, record, { LastModifiedDate: this.now(), LastModifiedById: USER });
        return { id, success: true, errors: [] };
      });
    }

    delete(object: string, ids: string[]): OperationOutcome[] {
      return ids.map((id) => {
        const row = this.row(object, id);
        if (!row) return { id, success: false, errors: ['ENTITY_IS_DELETED: entity is deleted'] };
        const order = object === 'Order' ? row : this.row('Order', String(row.OrderId));
        const refusal =
          this.refuse?.('delete', object, row) ??
          (this.activated(order)
            ? 'FIELD_INTEGRITY_EXCEPTION: unable to modify activated order'
            : undefined);
        if (refusal) return { id, success: false, errors: [refusal] };
        this.rows.set(
          object,
          (this.rows.get(object) ?? []).filter((r) => r.Id !== id),
        );
        if (object === 'Order') {
          this.rows.set(
            'OrderItem',
            (this.rows.get('OrderItem') ?? []).filter((item) => item.OrderId !== id),
          );
        }
        return { id, success: true, errors: [] };
      });
    }

    /** The loader's writer: every write answered as the target answers it. */
    writer(): FrozenDmlWriter {
      return {
        insert: vi.fn(async (_org: string, object: string, records: Record<string, unknown>[]) =>
          records.map((record) => {
            const id = `${object.slice(0, 3)}${String(++this.inserted).padStart(12, '0')}AAA`;
            const at = this.now();
            const created = { CreatedDate: at, LastModifiedDate: at, SystemModstamp: at };
            this.rows.set(object, [
              ...(this.rows.get(object) ?? []),
              { ...record, ...created, Id: id, CreatedById: USER, LastModifiedById: USER },
            ]);
            return { id, success: true, errors: [] };
          }),
        ),
        update: vi.fn(async (_org: string, object: string, records: Record<string, unknown>[]) =>
          this.update(object, records),
        ),
        delete: vi.fn(async (_org: string, object: string, ids: string[]) =>
          this.delete(object, ids),
        ),
      };
    }

    /** The target as a removal of a load reaches it. */
    removalOrg(): RemovalOrg {
      const answer = (outcomes: OperationOutcome[]) =>
        outcomes.map(({ id, success, errors }) => ({
          id,
          success,
          errors: errors.map((error) => ({ statusCode: error.split(':')[0], message: error })),
        }));
      return {
        query: async (soql) => {
          const records = this.select(soql);
          return { totalSize: records.length, done: true, records };
        },
        destroy: async (object, ids) => answer(this.delete(object, ids)),
        update: async (object, records) => answer(this.update(object, records)),
        describe: async (object) => ({
          name: object,
          label: object,
          fields: [],
          childRelationships:
            object === 'Order'
              ? [{ childSObject: 'OrderItem', field: 'OrderId', cascadeDelete: true }]
              : [],
        }),
        describeGlobal: async () => ({
          sobjects: ['Order', 'OrderItem'].map((name) => ({
            name,
            label: name,
            queryable: true,
            createable: true,
            layoutable: true,
          })),
        }),
        serverTime: async () => this.now(),
        userId: async () => USER,
      };
    }
  }

  /** The mapping of the load that created the order and its item. */
  async function orderLoaded(sasDir: string): Promise<void> {
    await new SasReferenceIdMappingStore(sasDir, {
      guard: new SasPathGuard(repoRoot),
      now: () => new Date('2026-09-23T10:00:06.000Z'),
    }).persist(
      new Map([
        ['Order-000001', ORDER],
        ['OrderItem-000001', ITEM],
      ]),
      {
        created: [
          { objectApiName: 'Order', referenceIds: ['Order-000001'] },
          { objectApiName: 'OrderItem', referenceIds: ['OrderItem-000001'] },
        ],
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
        writtenBetween: LOADED,
      },
    );
  }

  /** The loads the sas records, the last first. */
  const recordedLoads = (sasDir: string) =>
    new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).recordedLoads();

  /**
   * Remove the load a removal takes next, as the Load tab's card removes it:
   * dated by the target's dates of what it wrote, or, for a load the target
   * did not date, by this machine's clock as it began and as it ended.
   */
  async function removeNextLoad(sasDir: string, target: OrderTarget) {
    const load = loadToRemove(await recordedLoads(sasDir));
    if (!load) throw new Error('no load to remove');
    const span = load.writtenBetween;
    const began = Date.parse(load.startedAt ?? '');
    const ended = Date.parse(load.endedAt);
    const outcome = await removeRunRecords(target.removalOrg(), loadCreatedRecords(load), {
      ...(span
        ? { runStartedAt: new Date(span.first), runEndedAt: new Date(span.last) }
        : { runDurationMs: ended - began, runRecordedAt: new Date(ended) }),
      removalStamps: load.removalStamps,
      removalSpans: load.removalSpans,
      includeChanged: false,
    });
    return outcome.objects.map(
      (o) =>
        `${o.objectApiName}: ${o.deleted} deleted, ${o.keptChanged} kept changed, ${o.refused} refused`,
    );
  }

  /**
   * A reload of a dataset without the order, over its target, with the load's
   * writer stopped by the cancel as the bulk writer is — a write sent once the
   * cancel came writes nothing — and the cancel coming as the order is set to
   * Draft.
   *
   * @param afterGiveBack - What happens in the target once the order's status
   *   is given back, before anything else is asked of it.
   */
  function reloadCancelledAtTheDraft(
    target: OrderTarget,
    sasDir: string,
    clock: Pick<FrozenDatasetLoaderDeps, 'serverTime'> = {},
    afterGiveBack?: () => void,
  ) {
    const dataset = makeAccountContactDataset();
    const stop = new AbortController();
    const writes = target.writer();
    const writer: FrozenDmlWriter = {
      insert: async (...args) => (stop.signal.aborted ? [] : writes.insert(...args)),
      update: async (...args) => {
        if (stop.signal.aborted) return [];
        const outcomes = await writes.update(...args);
        if (args[1] === 'Order') stop.abort();
        return outcomes;
      },
      delete: async (...args) => (stop.signal.aborted ? [] : writes.delete(...args)),
    };
    const deps = {
      ...makeDeps({
        dataset,
        sasDir,
        writer,
        queryImpl: async (_org: string, soql: string) => target.select(soql),
        userId: USER,
      }),
      restoringWriter: {
        ...writes,
        update: async (...args: Parameters<FrozenDmlWriter['update']>) => {
          const outcomes = await writes.update(...args);
          afterGiveBack?.();
          return outcomes;
        },
      },
      ...clock,
    };
    return new FrozenDatasetLoader(deps)
      .load(makeOptions(deps, dataset, { reload: true, signal: stop.signal }))
      .catch((e: unknown) => e);
  }

  it('gives the order its status back when a cancel stops the reload before its delete, and its removal takes it', async () => {
    const target = new OrderTarget();
    const sasDir = makeTmpDir();
    await orderLoaded(sasDir);

    const error = await reloadCancelledAtTheDraft(target, sasDir);

    expect(error).toBeInstanceOf(FrozenLoadCancelledError);
    // Set to Draft for its delete, and given its status back: nothing was deleted.
    expect(target.row('Order', ORDER)?.Status).toBe('ST002');
    expect(target.row('OrderItem', ITEM)).toBeDefined();
    // What the reload left on it is its doing, not a change: the removal of
    // the load that created the order takes it.
    expect(await removeNextLoad(sasDir, target)).toEqual([
      'OrderItem: 1 deleted, 0 kept changed, 0 refused',
      'Order: 1 deleted, 0 kept changed, 0 refused',
    ]);
  });

  it('gives it back when Production Guard refuses the delete that follows, without keeping a mapping of its own', async () => {
    const target = new OrderTarget();
    const sasDir = makeTmpDir();
    await orderLoaded(sasDir);
    const guard = new ProductionGuard();
    const judge = guard.check.bind(guard);
    vi.spyOn(guard, 'check').mockImplementation((request) =>
      request.operation === 'delete'
        ? {
            allowed: false,
            requiresConfirmation: false,
            requiresApproval: false,
            blockedReason: 'not on this org',
            warnings: [],
            impactSummary: '',
          }
        : judge(request),
    );
    const dataset = makeAccountContactDataset();
    const deps = makeDeps({
      dataset,
      sasDir,
      guard,
      writer: target.writer(),
      queryImpl: async (_org, soql) => target.select(soql),
      userId: USER,
    });

    const error = await new FrozenDatasetLoader(deps)
      .load(makeOptions(deps, dataset, { reload: true }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LoadGuardError);
    expect(target.row('Order', ORDER)?.Status).toBe('ST002');
    // Nothing created or purged: the mapping names the load that created the
    // order, with what the reload left on it.
    const loads = await recordedLoads(sasDir);
    expect(loads).toHaveLength(1);
    expect(loads[0].removalStamps).toEqual({
      [ORDER]: target.row('Order', ORDER)?.LastModifiedDate,
    });
    expect(await removeNextLoad(sasDir, target)).toEqual([
      'OrderItem: 1 deleted, 0 kept changed, 0 refused',
      'Order: 1 deleted, 0 kept changed, 0 refused',
    ]);
  });

  it('gives back the status of an order the target would not let it delete, and names one it could not', async () => {
    const target = new OrderTarget();
    target.rows.set('Order', [
      target.loaded(ORDER, { Status: 'ST002' }),
      target.loaded(OTHER_ORDER, { Status: 'ST002' }),
    ]);
    target.refuse = (operation, object, record) => {
      if (operation === 'delete' && object === 'Order') return 'DELETE_FAILED: it has invoices';
      if (operation === 'update' && record.Id === OTHER_ORDER && record.Status === 'ST002') {
        return 'FIELD_CUSTOM_VALIDATION_EXCEPTION: activation is closed this month';
      }
      return undefined;
    };
    const sasDir = makeTmpDir();
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map([
        ['Order-000001', ORDER],
        ['Order-000002', OTHER_ORDER],
      ]),
      {
        created: [{ objectApiName: 'Order', referenceIds: ['Order-000001', 'Order-000002'] }],
        startedAt: new Date('2026-09-23T10:00:00.000Z'),
        writtenBetween: LOADED,
      },
    );
    const dataset = makeAccountContactDataset();
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: target.writer(),
      queryImpl: async (_org, soql) => target.select(soql),
      userId: USER,
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { reload: true }),
    );

    expect(target.row('Order', ORDER)?.Status).toBe('ST002');
    expect(target.row('Order', OTHER_ORDER)?.Status).toBe('ST001');
    expect(report.status).toBe('completed-with-errors');
    expect(report.purge.failures).toEqual([
      { objectApiName: 'Order', recordId: ORDER, errors: ['DELETE_FAILED: it has invoices'] },
      {
        objectApiName: 'Order',
        recordId: OTHER_ORDER,
        errors: [
          'DELETE_FAILED: it has invoices',
          'Status set to ST001 for the purge, and left there: ST002 could not be given back — ' +
            'FIELD_CUSTOM_VALIDATION_EXCEPTION: activation is closed this month',
        ],
      },
    ]);
    // Both stay named with the load that created them, with what the purge left on them.
    const [, earlier] = await recordedLoads(sasDir);
    expect(Object.keys(earlier.removalStamps).sort()).toEqual([ORDER, OTHER_ORDER]);
  });

  it('stamps no order someone changed since the load that created it: that change stays one', async () => {
    const target = new OrderTarget();
    Object.assign(target.row('Order', ORDER) ?? {}, {
      LastModifiedDate: '2026-09-23T15:00:00.000+0000',
      LastModifiedById: COLLEAGUE,
    });
    const sasDir = makeTmpDir();
    await orderLoaded(sasDir);

    const error = await reloadCancelledAtTheDraft(target, sasDir);

    expect(error).toBeInstanceOf(FrozenLoadCancelledError);
    expect(target.row('Order', ORDER)?.Status).toBe('ST002');
    // Nothing created or purged: the mapping names the load that created the
    // order, and nothing the reload left on it.
    const loads = await recordedLoads(sasDir);
    expect(loads).toHaveLength(1);
    expect(loads[0].removalStamps).toEqual({});
    // Its item is refused under an order still activated.
    expect(await removeNextLoad(sasDir, target)).toEqual([
      'OrderItem: 0 deleted, 0 kept changed, 1 refused',
      'Order: 0 deleted, 1 kept changed, 0 refused',
    ]);
  });

  describe('of a load the target did not date', () => {
    // A load whose dates could not all be read back is dated, by its removal,
    // by this machine's clock as it ended, read on the target's. The purge
    // judged its records by no date at all: the order it gave back was never
    // stamped, and the removal of that load kept it as changed since.

    /** The mapping of the load that created the order and its item, undated by the target. */
    async function orderLoadedUndated(sasDir: string): Promise<void> {
      await new SasReferenceIdMappingStore(sasDir, {
        guard: new SasPathGuard(repoRoot),
        now: () => new Date('2026-09-23T10:00:06.000Z'),
      }).persist(
        new Map([
          ['Order-000001', ORDER],
          ['OrderItem-000001', ITEM],
        ]),
        {
          created: [
            { objectApiName: 'Order', referenceIds: ['Order-000001'] },
            { objectApiName: 'OrderItem', referenceIds: ['OrderItem-000001'] },
          ],
          startedAt: new Date('2026-09-23T10:00:00.000Z'),
        },
      );
    }

    beforeEach(() => {
      // This machine's clock, a few seconds behind the target's.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stamps what it gave back of a record as that load left it, and the removal of that load takes it', async () => {
      const target = new OrderTarget();
      const sasDir = makeTmpDir();
      await orderLoadedUndated(sasDir);

      const error = await reloadCancelledAtTheDraft(target, sasDir, {
        serverTime: async () => target.now(),
      });

      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect(target.row('Order', ORDER)?.Status).toBe('ST002');
      const [load] = await recordedLoads(sasDir);
      expect(load.writtenBetween).toBeUndefined();
      expect(load.removalStamps).toEqual({
        [ORDER]: target.row('Order', ORDER)?.LastModifiedDate,
      });
      expect(await removeNextLoad(sasDir, target)).toEqual([
        'OrderItem: 1 deleted, 0 kept changed, 0 refused',
        'Order: 1 deleted, 0 kept changed, 0 refused',
      ]);
    });

    it('stamps no order someone changed since that load', async () => {
      const target = new OrderTarget();
      Object.assign(target.row('Order', ORDER) ?? {}, {
        LastModifiedDate: '2026-09-23T15:00:00.000+0000',
        LastModifiedById: COLLEAGUE,
      });
      const sasDir = makeTmpDir();
      await orderLoadedUndated(sasDir);

      await reloadCancelledAtTheDraft(target, sasDir, { serverTime: async () => target.now() });

      const [load] = await recordedLoads(sasDir);
      expect(load.removalStamps).toEqual({});
      expect(await removeNextLoad(sasDir, target)).toEqual([
        'OrderItem: 0 deleted, 0 kept changed, 1 refused',
        'Order: 0 deleted, 1 kept changed, 0 refused',
      ]);
    });

    it('stamps nothing when the target does not tell its clock: no date says what is as that load left it', async () => {
      const target = new OrderTarget();
      const sasDir = makeTmpDir();
      await orderLoadedUndated(sasDir);

      await reloadCancelledAtTheDraft(target, sasDir, {
        serverTime: async () => {
          throw new Error('INVALID_SESSION_ID');
        },
      });

      const [load] = await recordedLoads(sasDir);
      expect(load.removalStamps).toEqual({});
    });
  });

  it('stamps no order a colleague edits between its status given back and the stamp read', async () => {
    // Read by its date alone, the colleague's edit was kept as the reload's
    // doing, and the removal of the load deleted the order it was made on.
    const target = new OrderTarget();
    const sasDir = makeTmpDir();
    await orderLoaded(sasDir);

    const error = await reloadCancelledAtTheDraft(target, sasDir, {}, () => {
      Object.assign(target.row('Order', ORDER) ?? {}, {
        Description: 'Keep for the audit',
        LastModifiedDate: target.now(),
        LastModifiedById: COLLEAGUE,
      });
    });

    expect(error).toBeInstanceOf(FrozenLoadCancelledError);
    expect(target.row('Order', ORDER)?.Status).toBe('ST002');
    const loads = await recordedLoads(sasDir);
    expect(loads).toHaveLength(1);
    expect(loads[0].removalStamps).toEqual({});
    expect(await removeNextLoad(sasDir, target)).toEqual([
      'OrderItem: 0 deleted, 0 kept changed, 1 refused',
      'Order: 0 deleted, 1 kept changed, 0 refused',
    ]);
    expect(target.row('Order', ORDER)?.Description).toBe('Keep for the audit');
  });

  it('stamps nothing when the target does not say which user the reload writes as', async () => {
    const target = new OrderTarget();
    const sasDir = makeTmpDir();
    await orderLoaded(sasDir);
    const dataset = makeAccountContactDataset();
    const deps = makeDeps({
      dataset,
      sasDir,
      writer: target.writer(),
      queryImpl: async (_org, soql) => target.select(soql),
    });
    target.refuse = (operation, object) =>
      operation === 'delete' && object === 'Order' ? 'DELETE_FAILED: it has invoices' : undefined;

    await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset, { reload: true }));

    expect(target.row('Order', ORDER)?.Status).toBe('ST002');
    const [, earlier] = await recordedLoads(sasDir);
    expect(earlier.removalStamps).toEqual({});
  });
});

describe('FrozenDatasetLoader — a feed item the platform writes itself', () => {
  /**
   * An opportunity, a post and a tracked change on its feed, and a comment on
   * each: a dataset frozen before extractions left tracked changes out, by
   * rules that kept the type of a feed item.
   */
  function feedDataset(feed: 'post and change' | 'change only' = 'post and change'): FrozenDataset {
    const post = {
      referenceId: 'FeedItem-000001',
      fields: { Type: 'TextPost', Body: 'Kick-off', ParentId: 'Opportunity-000001' },
    };
    const change = {
      referenceId: 'FeedItem-000002',
      fields: { Type: 'TrackedChange', ParentId: 'Opportunity-000001' },
    };
    const onPost = {
      referenceId: 'FeedComment-000001',
      fields: { CommentBody: 'On the post', FeedItemId: 'FeedItem-000001' },
    };
    const onChange = {
      referenceId: 'FeedComment-000002',
      fields: { CommentBody: 'On the change', FeedItemId: 'FeedItem-000002' },
    };
    return {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Opportunity',
          records: [{ referenceId: 'Opportunity-000001', fields: { Name: 'Deal' } }],
        },
        {
          objectApiName: 'FeedItem',
          records: feed === 'change only' ? [change] : [post, change],
        },
        {
          objectApiName: 'FeedComment',
          records: feed === 'change only' ? [onChange] : [onPost, onChange],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
  }

  /** The target as it describes a comment: it may not leave its feed item empty. */
  function describesOf(dataset: FrozenDataset): Record<string, TargetObjectDescribe> {
    const describes = describeFromDataset(dataset);
    describes.FeedComment.fields = describes.FeedComment.fields.map((f) =>
      f.name === 'FeedItemId' ? { ...f, nillable: false, referenceTo: ['FeedItem'] } : f,
    );
    return describes;
  }

  /** What each insert of an object sent, in order. */
  function insertedOf(calls: DmlCall[], objectApiName: string): Array<Record<string, unknown>> {
    return calls
      .filter((c) => c.op === 'insert' && c.objectApiName === objectApiName)
      .flatMap((c) => c.payload as Array<Record<string, unknown>>);
  }

  it('leaves out a tracked change a dataset carries, and the comment on it, and says so', async () => {
    // Sent, the platform refuses a tracked change — "Cannot directly insert
    // FeedItem with type TrackedChange" — and the comment on it, which cannot
    // go in without the feed item it answers.
    const dataset = feedDataset();
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, describes: describesOf(dataset), writer: makeWriter(calls) });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(insertedOf(calls, 'FeedItem').map((r) => r.Type)).toEqual(['TextPost']);
    expect(insertedOf(calls, 'FeedComment').map((r) => r.CommentBody)).toEqual(['On the post']);
    expect(report.status).toBe('completed');
    expect(report.leftToThePlatform).toEqual([
      {
        objectApiName: 'FeedItem',
        count: 1,
        note: '1 tracked change left out: the platform writes them itself',
      },
      {
        objectApiName: 'FeedComment',
        count: 1,
        note: '1 left out: FeedItemId names a tracked change, which the platform writes itself',
      },
    ]);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    for (const objectApiName of ['FeedItem', 'FeedComment']) {
      expect(contract.objects[objectApiName]).toEqual({
        fromFiles: 2,
        exclusionReasons: { 'left-to-the-platform': 1 },
        excluded: 1,
        added: 0,
        expected: 1,
      });
    }
  });

  it('counts in the contract an object whose every record it left to the platform', async () => {
    const dataset = feedDataset('change only');
    const calls: DmlCall[] = [];
    const deps = makeDeps({ dataset, describes: describesOf(dataset), writer: makeWriter(calls) });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(insertedOf(calls, 'FeedItem')).toEqual([]);
    expect(insertedOf(calls, 'FeedComment')).toEqual([]);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects['FeedItem']).toEqual({
      fromFiles: 1,
      exclusionReasons: { 'left-to-the-platform': 1 },
      excluded: 1,
      added: 0,
      expected: 0,
    });
  });

  describe('in a dataset that does not carry their type', () => {
    /**
     * As extracted before 1.38.2: the rules cleared the type of every feed
     * item — the tracked change's among them — or the extraction left it out.
     */
    function untypedDataset(): FrozenDataset {
      const dataset = feedDataset();
      const [post, change] = dataset.objects[1].records;
      post.fields.Type = '';
      delete change.fields.Type;
      return dataset;
    }

    it('leaves those feed items out, and what hangs from them, and says to extract it again', async () => {
      // Sent untyped, a feed item goes in as a post, and the tracked change
      // was refused as one: "Required fields are missing: [Body]".
      const dataset = untypedDataset();
      const calls: DmlCall[] = [];
      const deps = makeDeps({
        dataset,
        describes: describesOf(dataset),
        writer: makeWriter(calls),
      });

      const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

      expect(insertedOf(calls, 'FeedItem')).toEqual([]);
      expect(insertedOf(calls, 'FeedComment')).toEqual([]);
      expect(insertedOf(calls, 'Opportunity')).toEqual([{ Name: 'Deal' }]);
      expect(report.untypedFeedItems).toEqual([
        {
          objectApiName: 'FeedItem',
          count: 2,
          note:
            '2 feed items left out: the dataset does not carry their type, and a tracked ' +
            'change cannot be told from a post — extract the dataset again, with rules that ' +
            'keep FeedItem.Type',
        },
        {
          objectApiName: 'FeedComment',
          count: 2,
          note:
            '2 left out: FeedItemId names a feed item whose type the dataset does not carry ' +
            '— extract the dataset again, with rules that keep FeedItem.Type',
        },
      ]);
      expect(report).not.toHaveProperty('leftToThePlatform');
      // Left out before anything is asked of them: what the target requires
      // of a feed item never sent is nothing the load should ask a default for.
      expect(deps.orgAccess.describe).not.toHaveBeenCalledWith('00D-target', 'FeedItem');
      const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
      expect(contract.objects['FeedItem']).toEqual({
        fromFiles: 2,
        exclusionReasons: { 'untyped-feed-item': 2 },
        excluded: 2,
        added: 0,
        expected: 0,
      });
      expect(contract.objects['FeedComment']).toEqual({
        fromFiles: 2,
        exclusionReasons: { 'untyped-feed-item': 2 },
        excluded: 2,
        added: 0,
        expected: 0,
      });
    });

    it('still sends the feed items whose type it carries', async () => {
      const dataset = untypedDataset();
      dataset.objects[1].records[0].fields.Type = 'TextPost';
      const calls: DmlCall[] = [];
      const deps = makeDeps({
        dataset,
        describes: describesOf(dataset),
        writer: makeWriter(calls),
      });

      const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

      expect(insertedOf(calls, 'FeedItem').map((r) => r.Body)).toEqual(['Kick-off']);
      expect(insertedOf(calls, 'FeedComment').map((r) => r.CommentBody)).toEqual(['On the post']);
      expect(report.untypedFeedItems?.map((left) => [left.objectApiName, left.count])).toEqual([
        ['FeedItem', 1],
        ['FeedComment', 1],
      ]);
      expect(report.status).toBe('completed');
    });
  });
});

describe('FrozenDatasetLoader — an email, its task and their relations', () => {
  /** A record's referenceId as an extraction writes it: its object, then its number on six digits. */
  const ref = (objectApiName: string, n = 1): string =>
    `${objectApiName}-${String(n).padStart(6, '0')}`;
  /** The id the writer gives a record the load inserts: its object, then its rank among all inserts. */
  const real = (objectApiName: string, rank: number): string => `REAL-${objectApiName}-${rank}`;

  /**
   * An email sent from a quote, as a real dataset carried it once its rules
   * had cleared what they keep no value of: the email names its task and its
   * quote, the task its quote; the task's relation to its what lost `IsWhat`,
   * and the email's three relations their addresses.
   */
  function emailDataset(onACase = false): FrozenDataset {
    const parent = onACase
      ? {
          objectApiName: 'Case',
          records: [{ referenceId: ref('Case'), fields: { Subject: 'Broken' } }],
        }
      : {
          objectApiName: 'Quote',
          records: [{ referenceId: ref('Quote'), fields: { Name: 'Offer' } }],
        };
    const parentRef = parent.records[0].referenceId;
    return {
      datasetVersion: '1.0.0',
      objects: [
        parent,
        {
          objectApiName: 'Task',
          records: [{ referenceId: ref('Task'), fields: { Subject: '', WhatId: parentRef } }],
        },
        {
          objectApiName: 'EmailMessage',
          records: [
            {
              referenceId: ref('EmailMessage'),
              fields: {
                Subject: '',
                Status: '3',
                ActivityId: ref('Task'),
                ...(onACase ? { ParentId: parentRef } : { RelatedToId: parentRef }),
              },
            },
          ],
        },
        {
          objectApiName: 'TaskRelation',
          records: [
            {
              referenceId: ref('TaskRelation'),
              fields: { TaskId: ref('Task'), RelationId: parentRef, IsWhat: '' },
            },
          ],
        },
        {
          objectApiName: 'EmailMessageRelation',
          records: ['FromAddress', 'ToAddress', 'BccAddress'].map((type, i) => ({
            referenceId: ref('EmailMessageRelation', i + 1),
            fields: {
              EmailMessageId: ref('EmailMessage'),
              RelationType: type,
              RelationId: '',
              RelationAddress: '',
            },
          })),
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
  }

  /**
   * A writer answering as the target does: it refuses an email naming its
   * task unless the email is on a case — its ParentId, or a case, whose id
   * begins with 500, in its RelatedToId — and an email's task given later, a
   * field it takes at insert or never — a task's relation to anything but a
   * contact that does not say it is to the task's what, and an email's
   * relation that names no one; and it keeps the emails it took.
   */
  function platformWriter(
    calls: DmlCall[],
    emails: Array<Record<string, unknown>>,
  ): FrozenDmlWriter {
    const writer = makeWriter(calls);
    const update = writer.update;
    writer.update = vi.fn(
      async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        const outcomes = await update(org, objectApiName, records);
        return outcomes.map((outcome, i) =>
          objectApiName === 'EmailMessage' && 'ActivityId' in records[i]
            ? {
                id: outcome.id,
                success: false,
                errors: ['INSUFFICIENT_ACCESS_OR_READONLY: you cannot modify this field'],
              }
            : outcome,
        );
      },
    );
    const insert = writer.insert;
    writer.insert = vi.fn(
      async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        const outcomes = await insert(org, objectApiName, records);
        return outcomes.map((outcome, i) => {
          const record = records[i];
          const refused = (error: string) => ({ id: '', success: false, errors: [error] });
          const onACase =
            Boolean(record.ParentId) || String(record.RelatedToId ?? '').startsWith('500');
          if (objectApiName === 'EmailMessage' && record.ActivityId && !onACase) {
            return refused('INSUFFICIENT_ACCESS_OR_READONLY: you cannot modify this field');
          }
          if (
            objectApiName === 'TaskRelation' &&
            record.IsWhat !== true &&
            !String(record.RelationId).startsWith('REAL-Contact')
          ) {
            return refused(
              'FIELD_INTEGRITY_EXCEPTION: RelationId must be a contact or lead when isWhat is false.',
            );
          }
          if (
            objectApiName === 'EmailMessageRelation' &&
            !record.RelationId &&
            !record.RelationAddress
          ) {
            return refused(
              'INVALID_OPERATION: an email relation needs a RelationId or a RelationAddress',
            );
          }
          if (objectApiName === 'EmailMessage') emails.push({ Id: outcome.id, ...record });
          return outcome;
        });
      },
    );
    return writer;
  }

  /**
   * The target's answer to the load's reads: the task each email it took
   * names — the one the load gave an email on a case, or the one the platform
   * wrote with any other related to a record, when it writes one.
   */
  function platformReads(emails: Array<Record<string, unknown>>, writesTasks = true) {
    return async (_org: string, soql: string): Promise<Array<Record<string, unknown>>> =>
      soql.startsWith('SELECT Id, ActivityId FROM EmailMessage')
        ? emails.map((email) => ({
            Id: email.Id,
            ActivityId:
              email.ActivityId ?? (writesTasks && email.RelatedToId ? '00TPLATFORM' : null),
          }))
        : [];
  }

  /** What each insert of an object sent, in order. */
  function insertedOf(calls: DmlCall[], objectApiName: string): Array<Record<string, unknown>> {
    return calls
      .filter((c) => c.op === 'insert' && c.objectApiName === objectApiName)
      .flatMap((c) => c.payload as Array<Record<string, unknown>>);
  }

  it('sends the email before its task and without it, and links the task the platform wrote with it', async () => {
    // Run for real, the load sent the email with its task and the target
    // refused it: INSUFFICIENT_ACCESS_OR_READONLY, "you cannot modify this field".
    const dataset = emailDataset();
    const calls: DmlCall[] = [];
    const emails: Array<Record<string, unknown>> = [];
    const deps = makeDeps({
      dataset,
      writer: platformWriter(calls, emails),
      queryImpl: platformReads(emails),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(insertedOf(calls, 'EmailMessage')).toEqual([
      { Status: '3', RelatedToId: real('Quote', 1) },
    ]);
    expect(insertedOf(calls, 'Task')).toEqual([]);
    expect(report.perObject.find((o) => o.objectApiName === 'Task')).toMatchObject({
      fromFiles: 1,
      inserted: 0,
      reused: 1,
      failed: [],
    });
    expect(report.pass2.unresolved).toEqual([]);
    expect(report.status).toBe('completed');
    const mapping = await new SasReferenceIdMappingStore(deps.sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    expect(mapping.get(ref('Task'))).toBe('00TPLATFORM');
  });

  it('inserts the task after the email when the platform wrote none with it', async () => {
    const dataset = emailDataset();
    const calls: DmlCall[] = [];
    const emails: Array<Record<string, unknown>> = [];
    const deps = makeDeps({
      dataset,
      writer: platformWriter(calls, emails),
      queryImpl: platformReads(emails, false),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    const inserts = calls.filter((c) => c.op === 'insert').map((c) => c.objectApiName);
    expect(inserts.indexOf('EmailMessage')).toBeLessThan(inserts.indexOf('Task'));
    expect(insertedOf(calls, 'Task')).toEqual([{ WhatId: real('Quote', 1) }]);
    // Nor is the task given to the email afterwards: the platform takes it at
    // insert or never.
    expect(calls.filter((c) => c.op === 'update' && c.objectApiName === 'EmailMessage')).toEqual(
      [],
    );
    expect(report.pass2.unresolved).toEqual([]);
    expect(report.status).toBe('completed');
  });

  it("leaves the task's relation to its what and the email's relations to the platform, and says so", async () => {
    // Run for real, the load sent the relation to the quote without IsWhat,
    // which its rules had cleared, and the email's three relations without
    // their addresses: all four were refused.
    const dataset = emailDataset();
    const calls: DmlCall[] = [];
    const emails: Array<Record<string, unknown>> = [];
    const deps = makeDeps({
      dataset,
      writer: platformWriter(calls, emails),
      queryImpl: platformReads(emails),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(insertedOf(calls, 'TaskRelation')).toEqual([]);
    expect(insertedOf(calls, 'EmailMessageRelation')).toEqual([]);
    expect(report.perObject.flatMap((o) => o.failed)).toEqual([]);
    expect(report.leftToThePlatform).toEqual([
      {
        objectApiName: 'TaskRelation',
        count: 1,
        note: "1 what relation left out: the platform writes them itself, from the task's WhatId",
      },
      {
        objectApiName: 'EmailMessageRelation',
        count: 3,
        note: "3 email relations left out: the platform writes them itself, from the email's addresses",
      },
    ]);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects['EmailMessageRelation']).toEqual({
      fromFiles: 3,
      exclusionReasons: { 'left-to-the-platform': 3 },
      excluded: 3,
      added: 0,
      expected: 0,
    });
  });

  it("links a relation to the task's who the platform wrote with the task, and inserts one to another contact", async () => {
    const dataset = emailDataset();
    dataset.objects.unshift({
      objectApiName: 'Contact',
      records: [
        { referenceId: ref('Contact', 1), fields: { LastName: 'Who' } },
        { referenceId: ref('Contact', 2), fields: { LastName: 'Shared' } },
      ],
    });
    dataset.objects
      .find((o) => o.objectApiName === 'TaskRelation')
      ?.records.push(
        {
          referenceId: ref('TaskRelation', 2),
          fields: { TaskId: ref('Task'), RelationId: ref('Contact', 1), IsWhat: false },
        },
        {
          referenceId: ref('TaskRelation', 3),
          fields: { TaskId: ref('Task'), RelationId: ref('Contact', 2), IsWhat: false },
        },
      );
    const calls: DmlCall[] = [];
    const emails: Array<Record<string, unknown>> = [];
    const reads = platformReads(emails, false);
    const deps = makeDeps({
      dataset,
      writer: platformWriter(calls, emails),
      queryImpl: async (org, soql) =>
        soql.startsWith('SELECT Id, TaskId, RelationId FROM TaskRelation')
          ? // The relation the platform wrote from the task's who.
            [{ Id: '0RTPLATFORM', TaskId: real('Task', 5), RelationId: real('Contact', 1) }]
          : reads(org, soql),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(insertedOf(calls, 'TaskRelation')).toEqual([
      { TaskId: real('Task', 5), RelationId: real('Contact', 2), IsWhat: false },
    ]);
    expect(report.perObject.find((o) => o.objectApiName === 'TaskRelation')).toMatchObject({
      inserted: 1,
      reused: 1,
      failed: [],
    });
  });

  it("links a relation to the event's who the platform wrote with the event, and inserts one to an invitee", async () => {
    // The platform writes an event's relation to its who as it writes the
    // event, as it does a task's.
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Contact',
          records: [
            { referenceId: ref('Contact', 1), fields: { LastName: 'Who' } },
            { referenceId: ref('Contact', 2), fields: { LastName: 'Invited' } },
          ],
        },
        {
          objectApiName: 'Event',
          records: [
            { referenceId: ref('Event'), fields: { Subject: 'Visit', WhoId: ref('Contact', 1) } },
          ],
        },
        {
          objectApiName: 'EventRelation',
          records: [
            {
              referenceId: ref('EventRelation', 1),
              fields: { EventId: ref('Event'), RelationId: ref('Contact', 1), IsWhat: false },
            },
            {
              referenceId: ref('EventRelation', 2),
              fields: {
                EventId: ref('Event'),
                RelationId: ref('Contact', 2),
                IsInvitee: true,
                IsWhat: false,
              },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    };
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      queryImpl: async (_org, soql) =>
        soql.startsWith('SELECT Id, EventId, RelationId FROM EventRelation')
          ? // The relation the platform wrote from the event's who.
            [{ Id: '0REPLATFORM', EventId: real('Event', 3), RelationId: real('Contact', 1) }]
          : [],
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(insertedOf(calls, 'Event')).toEqual([{ Subject: 'Visit', WhoId: real('Contact', 1) }]);
    expect(insertedOf(calls, 'EventRelation')).toEqual([
      {
        EventId: real('Event', 3),
        RelationId: real('Contact', 2),
        IsInvitee: true,
        IsWhat: false,
      },
    ]);
    expect(report.perObject.find((o) => o.objectApiName === 'EventRelation')).toMatchObject({
      inserted: 1,
      reused: 1,
      failed: [],
    });
    const mapping = await new SasReferenceIdMappingStore(deps.sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).load();
    expect(mapping.get(ref('EventRelation', 1))).toBe('0REPLATFORM');
  });

  describe("an event's who the event also invites", () => {
    /**
     * A contact, an event whose who it is, and the event's one relation to
     * it, a parent and an invitee at once, as a dataset keeps the flags: in
     * text.
     */
    const invitedWho = (): FrozenDataset => ({
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Contact',
          records: [{ referenceId: ref('Contact'), fields: { LastName: 'Who' } }],
        },
        {
          objectApiName: 'Event',
          records: [
            { referenceId: ref('Event'), fields: { Subject: 'Visit', WhoId: ref('Contact') } },
          ],
        },
        {
          objectApiName: 'EventRelation',
          records: [
            {
              referenceId: ref('EventRelation'),
              fields: {
                EventId: ref('Event'),
                RelationId: ref('Contact'),
                IsParent: 'true',
                IsInvitee: 'true',
                IsWhat: 'false',
              },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [],
    });

    /**
     * Load it into a target that holds the relation the platform wrote for
     * the event's who, not an invitee, and describes `IsInvitee` as
     * `updateable`.
     */
    async function load(updateable: boolean) {
      const dataset = invitedWho();
      const describes = describeFromDataset(dataset);
      describes.EventRelation.fields = describes.EventRelation.fields.map((f) =>
        f.name === 'IsInvitee' ? { ...f, updateable } : f,
      );
      const calls: DmlCall[] = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const deps = makeDeps({
        dataset,
        describes,
        writer: makeWriter(calls),
        queryImpl: async (_org, soql) =>
          soql.startsWith('SELECT Id, EventId, RelationId FROM EventRelation')
            ? [{ Id: '0REPLATFORM', EventId: real('Event', 2), RelationId: real('Contact', 1) }]
            : [],
      });
      const report = await new FrozenDatasetLoader(deps).load(
        makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
      );
      const line = progress.filter(
        (e) => e.objectName === 'EventRelation' && e.status !== 'started',
      );
      return { calls, report, line };
    }

    it('gives the relation it links the invitee flag the row carried', async () => {
      // Linked to in place of the row, the who was no longer invited.
      const { calls, report, line } = await load(true);

      expect(insertedOf(calls, 'EventRelation')).toEqual([]);
      expect(calls.filter((c) => c.op === 'update' && c.objectApiName === 'EventRelation')).toEqual(
        [
          {
            op: 'update',
            objectApiName: 'EventRelation',
            payload: [{ Id: '0REPLATFORM', IsInvitee: true }],
          },
        ],
      );
      expect(report.perObject.find((o) => o.objectApiName === 'EventRelation')).toMatchObject({
        inserted: 0,
        reused: 1,
        failed: [],
      });
      expect(line.map((e) => e.message)).toEqual([
        'EventRelation: 0 inserted, 1 reused, 0 duplicates skipped, 0 failed',
      ]);
    });

    it("writes nothing to it and says so on the object's line when the target does not let the flag be updated", async () => {
      const { calls, line } = await load(false);

      expect(calls.filter((c) => c.op === 'update' && c.objectApiName === 'EventRelation')).toEqual(
        [],
      );
      expect(line.map((e) => e.message)).toEqual([
        'EventRelation: 0 inserted, 1 reused, 0 duplicates skipped, 0 failed, ' +
          '1 linked without IsInvitee: the target does not let it be updated',
      ]);
    });

    describe('when the load is cancelled while the relation is updated', () => {
      /** The target's refusal of a status it does not hold. */
      const TENTATIVE =
        'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Tentative';

      /**
       * Load it, the row carrying the invitee's `status` as well, into the
       * same target, where `answer` answers each update of the relation in
       * place of the target, handed the load's cancel.
       */
      async function loadCancelled(
        answer: (records: Array<Record<string, unknown>>, cancel: () => void) => OperationOutcome[],
        status?: string,
      ) {
        const dataset = invitedWho();
        const relation = dataset.objects.find((o) => o.objectApiName === 'EventRelation')
          ?.records[0];
        if (relation && status !== undefined) relation.fields.Status = status;
        const calls: DmlCall[] = [];
        const progress: FrozenLoadProgressEvent[] = [];
        const controller = new AbortController();
        const writer = makeWriter(calls);
        const update = writer.update;
        writer.update = vi.fn(
          async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
            if (objectApiName !== 'EventRelation') return update(org, objectApiName, records);
            calls.push({ op: 'update', objectApiName, payload: records });
            return answer(records, () => controller.abort());
          },
        );
        const deps = makeDeps({
          dataset,
          writer,
          queryImpl: async (_org, soql) =>
            soql.startsWith('SELECT Id, EventId, RelationId FROM EventRelation')
              ? [{ Id: '0REPLATFORM', EventId: real('Event', 2), RelationId: real('Contact', 1) }]
              : [],
        });
        const error = await new FrozenDatasetLoader(deps)
          .load(
            makeOptions(deps, dataset, {
              onProgress: (e) => progress.push(e),
              signal: controller.signal,
            }),
          )
          .catch((err: unknown) => err);
        return {
          error,
          updates: calls
            .filter((c) => c.op === 'update' && c.objectApiName === 'EventRelation')
            .map((c) => c.payload),
          line: progress
            .filter((e) => e.objectName === 'EventRelation' && e.status !== 'started')
            .map((e) => e.message),
        };
      }

      it('sends no update after the cancel, and says the refusal the target gave', async () => {
        // The update answered for its one relation: the cancel went unseen,
        // and the flag and the status the target refused went again, one at a
        // time, after it.
        const { error, updates, line } = await loadCancelled((records, cancel) => {
          cancel();
          return records.map(() => ({ success: false, errors: [TENTATIVE] }));
        }, 'Tentative');

        expect(error).toBeInstanceOf(FrozenLoadCancelledError);
        expect(updates).toEqual([[{ Id: '0REPLATFORM', IsInvitee: true, Status: 'Tentative' }]]);
        expect(line).toEqual([
          'EventRelation: 0 inserted, 1 reused, 0 duplicates skipped, 0 failed, ' +
            `1 linked without IsInvitee: the target refused the update, ${TENTATIVE}, ` +
            `1 linked without Status: the target refused the update, ${TENTATIVE}`,
        ]);
      });

      it("says on the object's line the relation an aborted update never reached was cancelled, not refused", async () => {
        // An upload the cancel aborted wrote nothing and answers for nothing:
        // the relation was said refused "without saying why".
        const { error, line } = await loadCancelled((_records, cancel) => {
          cancel();
          return [];
        });

        expect(error).toBeInstanceOf(FrozenLoadCancelledError);
        expect(line).toEqual([
          'EventRelation: 0 inserted, 1 reused, 0 duplicates skipped, 0 failed, ' +
            '1 linked without IsInvitee: the run was cancelled before it was updated',
        ]);
      });
    });

    describe('beside a contact the event also invites, whose relation the load inserts', () => {
      /**
       * `invitedWho`, the event inviting a second contact as well, whose
       * relation is not one the platform wrote: it goes in with the insert.
       * Loaded into the target of the other tests, where `cancelAt` is the
       * moment the load's cancel comes: as the relations the target holds
       * are looked up, or as the flag goes back to the one it linked.
       */
      async function loadInviting(cancelAt: 'lookup' | 'update') {
        const dataset = invitedWho();
        dataset.objects
          .find((o) => o.objectApiName === 'Contact')
          ?.records.push({ referenceId: ref('Contact', 2), fields: { LastName: 'Invited' } });
        dataset.objects
          .find((o) => o.objectApiName === 'EventRelation')
          ?.records.push({
            referenceId: ref('EventRelation', 2),
            fields: {
              EventId: ref('Event'),
              RelationId: ref('Contact', 2),
              IsInvitee: 'true',
              IsWhat: 'false',
            },
          });
        const calls: DmlCall[] = [];
        const progress: FrozenLoadProgressEvent[] = [];
        const controller = new AbortController();
        const writer = makeWriter(calls);
        const update = writer.update;
        writer.update = vi.fn(
          async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
            if (objectApiName === 'EventRelation' && cancelAt === 'update') {
              calls.push({ op: 'update', objectApiName, payload: records });
              controller.abort();
              // An update the cancel aborted answers for nothing.
              return [];
            }
            return update(org, objectApiName, records);
          },
        );
        const deps = makeDeps({
          dataset,
          writer,
          queryImpl: async (_org, soql) => {
            if (!soql.startsWith('SELECT Id, EventId, RelationId FROM EventRelation')) return [];
            if (cancelAt === 'lookup') controller.abort();
            // The relation the platform wrote for the event's who.
            return [
              { Id: '0REPLATFORM', EventId: real('Event', 3), RelationId: real('Contact', 1) },
            ];
          },
        });
        const error = await new FrozenDatasetLoader(deps)
          .load(
            makeOptions(deps, dataset, {
              onProgress: (e) => progress.push(e),
              signal: controller.signal,
            }),
          )
          .catch((err: unknown) => err);
        return {
          error,
          calls,
          line: progress
            .filter((e) => e.objectName === 'EventRelation' && e.status !== 'started')
            .map((e) => e.message),
        };
      }

      it('inserts none of the other relations after a cancel that came as the flag went back', async () => {
        // Nothing looked at the cancel between the flag and the insert: the
        // relation to the second contact went in after it.
        const { error, calls, line } = await loadInviting('update');

        expect(error).toBeInstanceOf(FrozenLoadCancelledError);
        expect(insertedOf(calls, 'EventRelation')).toEqual([]);
        expect(line).toEqual([
          'EventRelation: 0 inserted, 1 reused, 0 duplicates skipped, 0 failed, ' +
            '1 not inserted: the load was cancelled first, ' +
            '1 linked without IsInvitee: the run was cancelled before it was updated',
        ]);
        // The relation it linked is said with what the load wrote.
        expect((error as FrozenLoadCancelledError).written.perObject).toContainEqual(
          expect.objectContaining({ objectApiName: 'EventRelation', inserted: 0, reused: 1 }),
        );
      });

      it('gives no flag back and inserts none of the relations after a cancel that came as they were looked up', async () => {
        const { error, calls, line } = await loadInviting('lookup');

        expect(error).toBeInstanceOf(FrozenLoadCancelledError);
        expect(calls.filter((c) => c.objectApiName === 'EventRelation')).toEqual([]);
        expect(line).toEqual([
          'EventRelation: 0 inserted, 1 reused, 0 duplicates skipped, 0 failed, ' +
            '1 not inserted: the load was cancelled first, ' +
            '1 linked without IsInvitee: the run was cancelled before it was updated',
        ]);
      });
    });
  });

  it('writes the task first and names it on an email on a case, which may name it', async () => {
    const dataset = emailDataset(true);
    const calls: DmlCall[] = [];
    const emails: Array<Record<string, unknown>> = [];
    const deps = makeDeps({
      dataset,
      writer: platformWriter(calls, emails),
      queryImpl: platformReads(emails),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    const inserts = calls.filter((c) => c.op === 'insert').map((c) => c.objectApiName);
    expect(inserts.indexOf('Task')).toBeLessThan(inserts.indexOf('EmailMessage'));
    expect(insertedOf(calls, 'EmailMessage')).toEqual([
      { Status: '3', ActivityId: real('Task', 2), ParentId: real('Case', 1) },
    ]);
    expect(report.perObject.flatMap((o) => o.failed)).toEqual([]);
  });

  describe('emails on a case and others in one dataset', () => {
    /** A case's id in the target: it begins with 500, as in every org. */
    const CASE_ID = '500NEW000000001AAA';

    /**
     * An email sent from a quote, one on a case and one related to the case
     * alone, each with its task: what a dataset of an account's records held
     * once it carried both.
     */
    function mixedDataset(): FrozenDataset {
      const email = (n: number, fields: Record<string, unknown>) => ({
        referenceId: ref('EmailMessage', n),
        fields: { Subject: '', Status: '3', ActivityId: ref('Task', n), ...fields },
      });
      return {
        datasetVersion: '1.0.0',
        objects: [
          {
            objectApiName: 'Quote',
            records: [{ referenceId: ref('Quote'), fields: { Name: 'Offer' } }],
          },
          {
            objectApiName: 'Case',
            records: [{ referenceId: ref('Case'), fields: { Subject: 'Broken' } }],
          },
          {
            objectApiName: 'Task',
            records: [
              { referenceId: ref('Task', 1), fields: { Subject: 'Offer', WhatId: ref('Quote') } },
              { referenceId: ref('Task', 2), fields: { Subject: 'Unread', WhatId: ref('Case') } },
              { referenceId: ref('Task', 3), fields: { Subject: 'Second', WhatId: ref('Case') } },
            ],
          },
          {
            objectApiName: 'EmailMessage',
            records: [
              email(1, { RelatedToId: ref('Quote') }),
              email(2, { ParentId: ref('Case') }),
              email(3, { RelatedToId: ref('Case') }),
            ],
          },
        ],
        recordTypes: {},
        personContactSidecar: [],
      };
    }

    /** The platform's writer, giving each case it takes an id that begins with 500. */
    function withCaseIds(writer: FrozenDmlWriter): FrozenDmlWriter {
      const insert = writer.insert;
      writer.insert = vi.fn(
        async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
          const outcomes = await insert(org, objectApiName, records);
          return objectApiName === 'Case'
            ? outcomes.map((outcome) => ({ ...outcome, id: CASE_ID }))
            : outcomes;
        },
      );
      return writer;
    }

    it('inserts an email on a case after the task it names, with it, and the others before theirs', async () => {
      // A load that held an email on a case inserted every task first, and
      // the quote's email then went in with a task of its own from the
      // platform, beside the one the dataset carried: two for one email.
      const dataset = mixedDataset();
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const deps = makeDeps({
        dataset,
        writer: withCaseIds(platformWriter(calls, emails)),
        queryImpl: platformReads(emails),
      });

      const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

      const inserts = calls.filter((c) => c.op === 'insert').map((c) => c.objectApiName);
      expect(inserts.slice(-3)).toEqual(['EmailMessage', 'Task', 'EmailMessage']);
      expect(insertedOf(calls, 'Task').map((t) => t.Subject)).toEqual(['Unread', 'Second']);
      const [tasksWritten] = calls.filter((c) => c.op === 'insert' && c.objectApiName === 'Task');
      expect(insertedOf(calls, 'EmailMessage')).toEqual([
        { Status: '3', RelatedToId: real('Quote', 2) },
        { Status: '3', ActivityId: real('Task', 4), ParentId: CASE_ID },
        { Status: '3', ActivityId: real('Task', 5), RelatedToId: CASE_ID },
      ]);
      expect(tasksWritten.payload).toHaveLength(2);
      expect(report.perObject.find((o) => o.objectApiName === 'Task')).toMatchObject({
        fromFiles: 3,
        inserted: 2,
        reused: 1,
        failed: [],
      });
      expect(report.perObject.find((o) => o.objectApiName === 'EmailMessage')).toMatchObject({
        fromFiles: 3,
        inserted: 3,
        failed: [],
      });
      expect(report.status).toBe('completed');
      const mapping = await new SasReferenceIdMappingStore(deps.sasDir, {
        guard: new SasPathGuard(repoRoot),
      }).load();
      expect(mapping.get(ref('Task', 1))).toBe('00TPLATFORM');
    });

    /** The lines that end the email object, as the load said them. */
    function emailEnds(progress: readonly FrozenLoadProgressEvent[]): FrozenLoadProgressEvent[] {
      return progress.filter((e) => e.objectName === 'EmailMessage' && e.status !== 'started');
    }

    it('ends the email object in one line, with what each of its two writes came to', async () => {
      // Said as each write ended, the emails ended in two lines, the second
      // with the emails that had waited for their task alone: two read as
      // two objects.
      const dataset = mixedDataset();
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const deps = makeDeps({
        dataset,
        writer: withCaseIds(platformWriter(calls, emails)),
        queryImpl: platformReads(emails),
      });

      await new FrozenDatasetLoader(deps).load(
        makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
      );

      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'done',
          'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
            'waiting for their tasks; after their task: 2 inserted, 0 reused, 0 duplicates ' +
            'skipped, 0 failed',
        ],
      ]);
      // The first write's end is a step on the way, said as one.
      expect(
        progress.filter((e) => e.objectName === 'EmailMessage').map((e) => [e.status, e.message]),
      ).toContainEqual([
        'started',
        'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
          'waiting for their tasks',
      ]);
    });

    it('ends the email object in one line as a failure when its first write failed', async () => {
      const dataset = mixedDataset();
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const writer = withCaseIds(platformWriter(calls, emails));
      const insert = writer.insert;
      writer.insert = vi.fn(
        async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) =>
          objectApiName === 'EmailMessage' && records.some((r) => !r.ActivityId)
            ? records.map(() => ({
                id: '',
                success: false,
                errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no offer by email'],
              }))
            : insert(org, objectApiName, records),
      );
      const deps = makeDeps({ dataset, writer, queryImpl: platformReads(emails) });

      await new FrozenDatasetLoader(deps).load(
        makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
      );

      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'error',
          'EmailMessage: 0 inserted, 0 reused, 0 duplicates skipped, 1 failed, 2 on a case ' +
            'waiting for their tasks; after their task: 2 inserted, 0 reused, 0 duplicates ' +
            'skipped, 0 failed',
        ],
      ]);
    });

    it('ends the email object stopped, with its first write, when a cancel stops the load before the emails that waited', async () => {
      // Ended done, an object two of whose emails never went in read as
      // written whole.
      const dataset = mixedDataset();
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const stop = new AbortController();
      const writer = withCaseIds(platformWriter(calls, emails));
      const insert = writer.insert;
      writer.insert = vi.fn(
        async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
          if (objectApiName === 'Task') stop.abort();
          return insert(org, objectApiName, records);
        },
      );
      const deps = makeDeps({ dataset, writer, queryImpl: platformReads(emails) });

      await expect(
        new FrozenDatasetLoader(deps).load(
          makeOptions(deps, dataset, {
            signal: stop.signal,
            onProgress: (e) => progress.push(e),
          }),
        ),
      ).rejects.toBeInstanceOf(FrozenLoadCancelledError);

      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'stopped',
          'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
            'waiting for their tasks, 2 not inserted: the load was cancelled first',
        ],
      ]);
    });

    it('ends the email object stopped, with its first write, when a cancel stops the load before the task object', async () => {
      // The end of the first write is a step on the way, kept for the write
      // of the emails that wait for their task. The load stopped before the
      // task object's turn, and the object's last word was that step: what it
      // inserted, and what it held back, was said nowhere.
      const dataset = mixedDataset();
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const stop = new AbortController();
      const writer = withCaseIds(platformWriter(calls, emails));
      const insert = writer.insert;
      writer.insert = vi.fn(
        async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
          if (objectApiName === 'EmailMessage') stop.abort();
          return insert(org, objectApiName, records);
        },
      );
      const deps = makeDeps({ dataset, writer, queryImpl: platformReads(emails) });

      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(
          makeOptions(deps, dataset, {
            signal: stop.signal,
            onProgress: (e) => progress.push(e),
          }),
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect(insertedOf(calls, 'Task')).toEqual([]);
      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'stopped',
          'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
            'waiting for their tasks, 2 not inserted: the load was cancelled first',
        ],
      ]);
      // The audit trail counts them as the line does.
      expect((error as FrozenLoadCancelledError).written.perObject).toContainEqual(
        expect.objectContaining({ objectApiName: 'EmailMessage', inserted: 1, notInserted: 2 }),
      );
    });

    it('ends the email object stopped, with its first write, when a cancel stops the load at an object before the task object', async () => {
      // An order on the case goes in between the emails and the tasks, and
      // the cancel came as its statuses were read: the order ended on its
      // line, the email object on the step its first write had said.
      const dataset = mixedDataset();
      dataset.objects.push({
        objectApiName: 'Order',
        records: [
          {
            referenceId: ref('Order'),
            fields: { Name: 'Repair', Status: 'Activated', Case__c: ref('Case') },
          },
        ],
      });
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const stop = new AbortController();
      const reads = platformReads(emails);
      const deps = makeDeps({
        dataset,
        writer: withCaseIds(platformWriter(calls, emails)),
        queryImpl: async (org, soql) => {
          if (soql.includes('FROM OrderStatus')) stop.abort();
          return reads(org, soql);
        },
      });

      await expect(
        new FrozenDatasetLoader(deps).load(
          makeOptions(deps, dataset, {
            signal: stop.signal,
            onProgress: (e) => progress.push(e),
          }),
        ),
      ).rejects.toBeInstanceOf(FrozenLoadCancelledError);

      expect(insertedOf(calls, 'Order')).toEqual([]);
      expect(insertedOf(calls, 'Task')).toEqual([]);
      expect(
        progress
          .filter((e) => e.objectName === 'Order' && e.status !== 'started')
          .map((e) => [e.status, e.message]),
      ).toEqual([
        [
          'stopped',
          'Order: 0 inserted, 0 reused, 0 duplicates skipped, 0 failed, ' +
            '1 not inserted: the load was cancelled first',
        ],
      ]);
      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'stopped',
          'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
            'waiting for their tasks, 2 not inserted: the load was cancelled first',
        ],
      ]);
    });

    it('counts the emails that wait for their task with the rest when a cancel cuts the first write short', async () => {
      // The load stops once the object's line is said, before the task
      // object's turn: the emails that waited never go in either.
      const dataset = mixedDataset();
      dataset.objects
        .find((o) => o.objectApiName === 'Task')
        ?.records.push({
          referenceId: ref('Task', 4),
          fields: { Subject: 'Reminder', WhatId: ref('Quote') },
        });
      dataset.objects
        .find((o) => o.objectApiName === 'EmailMessage')
        ?.records.push({
          referenceId: ref('EmailMessage', 4),
          fields: {
            Subject: '',
            Status: '3',
            ActivityId: ref('Task', 4),
            RelatedToId: ref('Quote'),
          },
        });
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const stop = new AbortController();
      const writer = withCaseIds(platformWriter(calls, emails));
      const insert = writer.insert;
      writer.insert = vi.fn(
        async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
          const outcomes = await insert(org, objectApiName, records);
          if (objectApiName !== 'EmailMessage') return outcomes;
          // What the writer hands back when the cancel stops it before its
          // second call: the answer of the first.
          stop.abort();
          return outcomes.slice(0, 1);
        },
      );
      const deps = makeDeps({ dataset, writer, queryImpl: platformReads(emails) });

      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(
          makeOptions(deps, dataset, {
            signal: stop.signal,
            onProgress: (e) => progress.push(e),
          }),
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect(
        progress.filter((e) => e.objectName === 'EmailMessage').map((e) => [e.status, e.message]),
      ).toEqual([
        ['started', 'Inserting EmailMessage'],
        [
          'stopped',
          'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
            'waiting for their tasks, 3 not inserted: the load was cancelled first',
        ],
      ]);
      expect((error as FrozenLoadCancelledError).written.perObject).toContainEqual(
        expect.objectContaining({ objectApiName: 'EmailMessage', inserted: 1, notInserted: 3 }),
      );
    });

    it('ends the email object stopped when a cancel cuts short the write of the emails that waited', async () => {
      const dataset = mixedDataset();
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const stop = new AbortController();
      const writer = withCaseIds(platformWriter(calls, emails));
      const insert = writer.insert;
      writer.insert = vi.fn(
        async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
          const outcomes = await insert(org, objectApiName, records);
          if (objectApiName !== 'EmailMessage' || !records.some((r) => r.ActivityId)) {
            return outcomes;
          }
          stop.abort();
          return outcomes.slice(0, 1);
        },
      );
      const deps = makeDeps({ dataset, writer, queryImpl: platformReads(emails) });

      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(
          makeOptions(deps, dataset, {
            signal: stop.signal,
            onProgress: (e) => progress.push(e),
          }),
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FrozenLoadCancelledError);
      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'stopped',
          'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
            'waiting for their tasks; after their task: 1 inserted, 0 reused, 0 duplicates ' +
            'skipped, 0 failed, 1 not inserted: the load was cancelled first',
        ],
      ]);
      expect((error as FrozenLoadCancelledError).written.perObject).toContainEqual(
        expect.objectContaining({ objectApiName: 'EmailMessage', inserted: 2, notInserted: 1 }),
      );
    });

    it('ends the email object with its first write when the task write fails', async () => {
      // A failure between the emails and the tasks stopped the load with the
      // object's last word the step its first write had said: what it
      // inserted, and what it held back, went unsaid, as it did at a cancel.
      const dataset = mixedDataset();
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const writer = withCaseIds(platformWriter(calls, emails));
      const insert = writer.insert;
      writer.insert = vi.fn(
        async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
          if (objectApiName === 'Task') {
            throw new Error('UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record');
          }
          return insert(org, objectApiName, records);
        },
      );
      const deps = makeDeps({ dataset, writer, queryImpl: platformReads(emails) });

      await expect(
        new FrozenDatasetLoader(deps).load(
          makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
        ),
      ).rejects.toBeInstanceOf(FrozenLoadFailedError);

      expect(insertedOf(calls, 'EmailMessage')).toHaveLength(1);
      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'done',
          'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
            'waiting for their tasks, 2 not inserted: the load failed',
        ],
      ]);
    });

    it('ends the email object with its first write when Production Guard refuses an object before the task object', async () => {
      const dataset = mixedDataset();
      dataset.objects.push({
        objectApiName: 'Order',
        records: [{ referenceId: ref('Order'), fields: { Name: 'Repair', Case__c: ref('Case') } }],
      });
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const guard = new ProductionGuard();
      const judge = guard.check.bind(guard);
      vi.spyOn(guard, 'check').mockImplementation((request: OperationRequest) =>
        request.objectName === 'Order'
          ? {
              allowed: false,
              requiresConfirmation: false,
              requiresApproval: false,
              blockedReason: 'not on this org',
              warnings: [],
              impactSummary: '',
            }
          : judge(request),
      );
      const deps = makeDeps({
        dataset,
        guard,
        writer: withCaseIds(platformWriter(calls, emails)),
        queryImpl: platformReads(emails),
      });

      const error: unknown = await new FrozenDatasetLoader(deps)
        .load(makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FrozenLoadFailedError);
      expect((error as Error).cause).toBeInstanceOf(LoadGuardError);
      expect(insertedOf(calls, 'Task')).toEqual([]);
      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'done',
          'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
            'waiting for their tasks, 2 not inserted: the load failed',
        ],
      ]);
    });

    it('ends the email object with its first write, as a failure it stays, when the write of the emails that waited fails', async () => {
      const dataset = mixedDataset();
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const writer = withCaseIds(platformWriter(calls, emails));
      const insert = writer.insert;
      writer.insert = vi.fn(
        async (org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
          if (objectApiName === 'EmailMessage' && records.some((r) => r.ActivityId)) {
            throw new Error('Bulk job failed: the connection was reset');
          }
          if (objectApiName === 'EmailMessage') {
            return records.map(() => ({
              id: '',
              success: false,
              errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no offer by email'],
            }));
          }
          return insert(org, objectApiName, records);
        },
      );
      const deps = makeDeps({ dataset, writer, queryImpl: platformReads(emails) });

      await expect(
        new FrozenDatasetLoader(deps).load(
          makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
        ),
      ).rejects.toBeInstanceOf(FrozenLoadFailedError);

      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'error',
          'EmailMessage: 0 inserted, 0 reused, 0 duplicates skipped, 1 failed, 2 on a case ' +
            'waiting for their tasks, 2 not inserted: the load failed',
        ],
      ]);
    });

    it('inserts no task after a cancel that came as the tasks written with the emails were looked up', async () => {
      // Nothing looked at the cancel between the lookup and the insert: the
      // tasks the platform had not written went in after it.
      const dataset = mixedDataset();
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const stop = new AbortController();
      const reads = platformReads(emails);
      const deps = makeDeps({
        dataset,
        writer: withCaseIds(platformWriter(calls, emails)),
        queryImpl: async (org, soql) => {
          if (soql.startsWith('SELECT Id, ActivityId FROM EmailMessage')) stop.abort();
          return reads(org, soql);
        },
      });

      await expect(
        new FrozenDatasetLoader(deps).load(
          makeOptions(deps, dataset, {
            signal: stop.signal,
            onProgress: (e) => progress.push(e),
          }),
        ),
      ).rejects.toBeInstanceOf(FrozenLoadCancelledError);

      expect(insertedOf(calls, 'Task')).toEqual([]);
      expect(
        progress
          .filter((e) => e.objectName === 'Task' && e.status !== 'started')
          .map((e) => [e.status, e.message]),
      ).toEqual([
        [
          'stopped',
          'Task: 0 inserted, 1 reused, 0 duplicates skipped, 0 failed, ' +
            '2 not inserted: the load was cancelled first',
        ],
      ]);
      // The emails that waited for the tasks are not written, and the email
      // object ends on its first write's line.
      expect(insertedOf(calls, 'EmailMessage')).toHaveLength(1);
      expect(emailEnds(progress).map((e) => [e.status, e.message])).toEqual([
        [
          'stopped',
          'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
            'waiting for their tasks, 2 not inserted: the load was cancelled first',
        ],
      ]);
    });

    it("says what became of the object's other rows on the line that ends it", async () => {
      // An email that cannot go in without a row the platform writes itself
      // is left out with it: said on the step, the note was followed by a
      // line that ended the object without it.
      const dataset = mixedDataset();
      dataset.objects.unshift({
        objectApiName: 'FeedItem',
        records: [{ referenceId: ref('FeedItem'), fields: { Type: 'TrackedChange' } }],
      });
      dataset.objects
        .find((o) => o.objectApiName === 'EmailMessage')
        ?.records.push({
          referenceId: ref('EmailMessage', 4),
          fields: { Subject: '', Status: '3', Change__c: ref('FeedItem') },
        });
      const describes = describeFromDataset(dataset);
      describes.EmailMessage.fields = describes.EmailMessage.fields.map((f) =>
        f.name === 'Change__c' ? { ...f, nillable: false, referenceTo: ['FeedItem'] } : f,
      );
      const calls: DmlCall[] = [];
      const emails: Array<Record<string, unknown>> = [];
      const progress: FrozenLoadProgressEvent[] = [];
      const deps = makeDeps({
        dataset,
        describes,
        writer: withCaseIds(platformWriter(calls, emails)),
        queryImpl: platformReads(emails),
      });

      await new FrozenDatasetLoader(deps).load(
        makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
      );

      const note = '1 left out: Change__c names a tracked change, which the platform writes itself';
      expect(emailEnds(progress).map((e) => e.message)).toEqual([
        'EmailMessage: 1 inserted, 0 reused, 0 duplicates skipped, 0 failed, 2 on a case ' +
          'waiting for their tasks; after their task: 2 inserted, 0 reused, 0 duplicates ' +
          `skipped, 0 failed, ${note}`,
      ]);
      expect(
        progress.filter((e) => e.objectName === 'EmailMessage' && e.message.includes(note)),
      ).toHaveLength(1);
    });
  });
});
