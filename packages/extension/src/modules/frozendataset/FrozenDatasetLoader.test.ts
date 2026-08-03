import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { SasReferenceIdMappingStore } from './SasReferenceIdMappingStore.js';
import { readCountingContract } from './CountingContract.js';
import {
  FrozenDatasetLoader,
  LoadConfigError,
  type FrozenDatasetLoaderDeps,
  type FrozenLoadOptions,
} from './FrozenDatasetLoader.js';
import { LoadGuardError } from './LoadGuards.js';
import type { FrozenDataset } from './types.js';
import type {
  FrozenDmlWriter,
  FrozenLoadConfig,
  TargetFieldDescribe,
  TargetObjectDescribe,
} from './loadTypes.js';

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
}

function makeDeps(options: MakeDepsOptions): FrozenDatasetLoaderDeps & { sasDir: string } {
  const sasDir = options.sasDir ?? makeTmpDir();
  const describes = options.describes ?? describeFromDataset(options.dataset);
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
});

describe('FrozenDatasetLoader — fresh load', () => {
  it('inserts parents before children, substitutes FKs, persists mapping and contract', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const guard = new ProductionGuard();
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
    // referenceId → real ID mapping persisted in the sas (spec pitfall 9).
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
    // ProductionGuard audit trail recorded every DML batch.
    expect(guard.getAuditLog().length).toBeGreaterThanOrEqual(2);
    expect(guard.getAuditLog()[0].request.module).toBe('frozendataset');
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

  it('excludes an object absent from the target org and lists it', async () => {
    const dataset = makeAccountContactDataset();
    const calls: DmlCall[] = [];
    const describes = describeFromDataset(dataset);
    delete describes.Contact; // Contact does not exist in the target
    const deps = makeDeps({ dataset, describes, writer: makeWriter(calls) });
    const loader = new FrozenDatasetLoader(deps);

    const report = await loader.load(makeOptions(deps, dataset));

    expect(report.alignment.excludedObjects).toHaveLength(1);
    expect(report.alignment.excludedObjects[0].objectApiName).toBe('Contact');
    expect(calls.map((c) => c.objectApiName)).toEqual(['Account']);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Contact).toBeUndefined();
  });

  it('resolves RecordTypeId by DeveloperName, never by label (spec pitfall 1)', async () => {
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

describe('FrozenDatasetLoader — required lookup placeholder (spec pitfall 3)', () => {
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
    // Pass 1: the cyclic FK of ObjA__c is nullified (target not inserted yet);
    // ObjB__c inserts directly with the real ObjA__c ID.
    expect((calls[0].payload as Array<Record<string, unknown>>)[0].B__c).toBeNull();
    expect((calls[1].payload as Array<Record<string, unknown>>)[0].A__c).toBe('REAL-ObjA__c-1');
    // Pass 2: targeted update patches the nullified FK.
    expect(calls[2].payload).toEqual([{ Id: 'REAL-ObjA__c-1', B__c: 'REAL-ObjB__c-2' }]);
    expect(report.pass2).toEqual({ resolved: 1, unresolved: [] });
  });

  it('restores Account.PersonContactId from the sidecar as targeted updates', async () => {
    const dataset = makeAccountContactDataset();
    // The frozen Account carries the sidecar referenceId in PersonContactId
    // (the field does not exist at insert time — spec §6).
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
});

describe('FrozenDatasetLoader — reload without refresh', () => {
  async function seedPreviousMapping(
    sasDir: string,
    entries: Record<string, string>,
  ): Promise<void> {
    await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
      new Map(Object.entries(entries)),
    );
  }

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

  it('DEACTIVATES undeletable objects instead of deleting them (spec pitfall 10)', async () => {
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
