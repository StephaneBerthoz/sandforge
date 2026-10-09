import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { STANDARD_PRICEBOOK_SOQL } from '@sandforge/shared';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { SasReferenceIdMappingStore } from './SasReferenceIdMappingStore.js';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-plan-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

/** DML call log entry. */
interface DmlCall {
  op: 'insert' | 'update' | 'delete';
  objectApiName: string;
  payload: unknown;
}

/** Writer mock: every DML succeeds, with ids of its own. */
function makeWriter(calls: DmlCall[]): FrozenDmlWriter {
  let counter = 0;
  return {
    insert: vi.fn(async (_org: string, objectApiName: string, records: unknown[]) => {
      calls.push({ op: 'insert', objectApiName, payload: records });
      return records.map(() => ({
        id: `REAL-${objectApiName}-${++counter}`,
        success: true,
        errors: [],
      }));
    }),
    update: vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'update', objectApiName, payload: records });
        return records.map((r) => ({ id: String(r.Id), success: true, errors: [] }));
      },
    ),
    delete: vi.fn(async (_org: string, objectApiName: string, ids: string[]) => {
      calls.push({ op: 'delete', objectApiName, payload: ids });
      return ids.map((id) => ({ id, success: true, errors: [] }));
    }),
  };
}

/** A writer any call to which fails the test: a preview writes nothing. */
function refusingWriter(): FrozenDmlWriter {
  const refuse = async (): Promise<never> => {
    throw new Error('a preview wrote to the target');
  };
  return { insert: vi.fn(refuse), update: vi.fn(refuse), delete: vi.fn(refuse) };
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

/**
 * A dataset and a target that exercise every count of a plan: two accounts,
 * one of which a reload finds by its key, and a required field the dataset
 * leaves empty; two contacts, one with a field the target lacks, one with a
 * picklist value it refuses, both without a required owner; the standard
 * price book, which the catalog links; an error log the target takes no
 * insert of. Before it, a load created a contact and a service resource,
 * which a reload purges — the resource, undeletable, deactivated.
 */
function scenario(): {
  dataset: FrozenDataset;
  describes: Record<string, TargetObjectDescribe>;
  config: FrozenLoadConfig;
  query: (orgId: string, soql: string) => Promise<Array<Record<string, unknown>>>;
} {
  const dataset: FrozenDataset = {
    datasetVersion: '1.0.0',
    objects: [
      {
        objectApiName: 'Pricebook2',
        records: [{ referenceId: 'Pricebook2-000001', fields: { Name: 'Standard' } }],
      },
      {
        objectApiName: 'Account',
        records: [
          { referenceId: 'Account-000001', fields: { Name: 'Kept', ExternalId__c: 'ACC-1' } },
          { referenceId: 'Account-000002', fields: { Name: 'New', ExternalId__c: 'ACC-2' } },
        ],
      },
      {
        objectApiName: 'Contact',
        records: [
          {
            referenceId: 'Contact-000001',
            fields: { LastName: 'One', AccountId: 'Account-000001', Level__c: 'Z' },
          },
          {
            referenceId: 'Contact-000002',
            fields: { LastName: 'Two', AccountId: 'Account-000002' },
          },
        ],
      },
      {
        objectApiName: 'ErrorLog__c',
        records: [{ referenceId: 'ErrorLog__c-000001', fields: { Message__c: 'failed' } }],
      },
    ],
    recordTypes: {},
    personContactSidecar: [],
    standardPricebook: 'Pricebook2-000001',
  };
  const describes: Record<string, TargetObjectDescribe> = {};
  for (const objectData of dataset.objects) {
    const names = new Set(objectData.records.flatMap((r) => Object.keys(r.fields)));
    describes[objectData.objectApiName] = {
      name: objectData.objectApiName,
      fields: [...names].map((name) => field({ name })),
    };
  }
  describes.Account.fields.push(field({ name: 'Rating__c', nillable: false }));
  describes.Contact.fields = describes.Contact.fields.map((f) =>
    f.name === 'Level__c'
      ? {
          ...f,
          type: 'picklist',
          restrictedPicklist: true,
          picklistValues: [{ value: 'A', active: true }],
        }
      : f,
  );
  describes.Contact.fields.push(
    field({ name: 'Owner__c', type: 'reference', nillable: false, referenceTo: ['Owner__c'] }),
  );
  describes.ErrorLog__c.createable = false;
  // Described before the target's lack of it is written into the record.
  (dataset.objects[2].records[1].fields as Record<string, unknown>).GhostField__c = 'boo';
  return {
    dataset,
    describes,
    config: {
      identityKeys: { Account: ['ExternalId__c'] },
      undeletableObjects: { ServiceResource: 'IsActive' },
      requiredFieldDefaults: { 'Account.Rating__c': 'Warm' },
      requiredLookupPlaceholders: { 'Contact.Owner__c': { name: 'SANDFORGE-OWNER' } },
    },
    query: async (_org, soql) => {
      if (soql === STANDARD_PRICEBOOK_SOQL) return [{ Id: '01sXX0000000STDAAA' }];
      if (soql.startsWith('SELECT Id, ExternalId__c FROM Account')) {
        return [{ Id: '001XX0000000OWNAAA', ExternalId__c: 'ACC-1' }];
      }
      return [];
    },
  };
}

/** What a load before this one created: a contact and a service resource. */
async function earlierLoad(sasDir: string): Promise<void> {
  await new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).persist(
    new Map([
      ['Contact-000009', '003XX0000000OLDAAA'],
      ['ServiceResource-000009', '0HnXX0000000OLDAAA'],
    ]),
    {
      created: [
        { objectApiName: 'Contact', referenceIds: ['Contact-000009'] },
        { objectApiName: 'ServiceResource', referenceIds: ['ServiceResource-000009'] },
      ],
      startedAt: new Date('2026-10-01T10:00:00.000Z'),
      writtenBetween: { first: '2026-10-01T10:00:01.000Z', last: '2026-10-01T10:00:09.000Z' },
    },
  );
}

function makeDeps(
  writer: FrozenDmlWriter,
  sasDir: string,
  s: ReturnType<typeof scenario>,
): FrozenDatasetLoaderDeps {
  return {
    orgAccess: {
      query: vi.fn(s.query),
      describe: vi.fn(async (_org: string, objectApiName: string) => {
        const describe = s.describes[objectApiName];
        if (!describe) throw new Error(`sObject ${objectApiName} not found`);
        return describe;
      }),
      picklistValues: vi.fn(async () => []),
    },
    writer,
    guard: new ProductionGuard(),
    mockDetector: { areCalloutsMocked: vi.fn(async () => true) },
    recordTypeResolver: { resolveByDeveloperName: vi.fn(async () => '012RT-RESOLVED') },
    mappingStore: new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }),
    config: s.config,
    sasGuard: new SasPathGuard(repoRoot),
  };
}

function options(
  dataset: FrozenDataset,
  sasDir: string,
  overrides?: Partial<FrozenLoadOptions>,
): FrozenLoadOptions {
  return { orgId: '00D-target', orgTier: 'development', dataset, sasDir, ...overrides };
}

describe('FrozenDatasetLoader — preview of a load', () => {
  it('reads the target and writes nothing, not even to the sas', async () => {
    const s = scenario();
    const sasDir = makeTmpDir();
    await earlierLoad(sasDir);
    const before = fs
      .readdirSync(sasDir)
      .map((name) => [name, fs.readFileSync(path.join(sasDir, name), 'utf8')]);
    const writer = refusingWriter();
    const deps = makeDeps(writer, sasDir, s);

    const plan = await new FrozenDatasetLoader(deps).planLoad(
      options(s.dataset, sasDir, { reload: true }),
    );

    expect(writer.insert).not.toHaveBeenCalled();
    expect(writer.update).not.toHaveBeenCalled();
    expect(writer.delete).not.toHaveBeenCalled();
    // Neither the mapping nor a counting contract written: the sas is as it was.
    expect(
      fs
        .readdirSync(sasDir)
        .map((name) => [name, fs.readFileSync(path.join(sasDir, name), 'utf8')]),
    ).toEqual(before);
    expect(plan.orgId).toBe('00D-target');
    expect(plan.mode).toEqual({ pilot: false, reload: true });
  });

  it('counts per object what the load that follows does, on the same dataset and target', async () => {
    const s = scenario();
    const sasDir = makeTmpDir();
    await earlierLoad(sasDir);

    const plan = await new FrozenDatasetLoader(makeDeps(refusingWriter(), sasDir, s)).planLoad(
      options(s.dataset, sasDir, { reload: true }),
    );
    const calls: DmlCall[] = [];
    const report = await new FrozenDatasetLoader(makeDeps(makeWriter(calls), sasDir, s)).load(
      options(s.dataset, sasDir, { reload: true }),
    );

    const byName = [...plan.perObject].sort((a, b) =>
      a.objectApiName.localeCompare(b.objectApiName),
    );
    expect(byName).toEqual([
      {
        objectApiName: 'Account',
        fromFiles: 2,
        toInsert: 1,
        reusedByKeys: 1,
        reusedFromCatalog: 0,
        fieldsDropped: 0,
        picklistsRewritten: 0,
        notSent: 0,
        toPurge: 0,
        toDeactivate: 0,
      },
      {
        objectApiName: 'Contact',
        fromFiles: 2,
        toInsert: 2,
        reusedByKeys: 0,
        reusedFromCatalog: 0,
        fieldsDropped: 1,
        picklistsRewritten: 1,
        notSent: 0,
        toPurge: 1,
        toDeactivate: 0,
      },
      {
        objectApiName: 'ErrorLog__c',
        fromFiles: 1,
        toInsert: 0,
        reusedByKeys: 0,
        reusedFromCatalog: 0,
        fieldsDropped: 0,
        picklistsRewritten: 0,
        notSent: 1,
        toPurge: 0,
        toDeactivate: 0,
      },
      {
        objectApiName: 'Pricebook2',
        fromFiles: 1,
        toInsert: 0,
        reusedByKeys: 0,
        reusedFromCatalog: 1,
        fieldsDropped: 0,
        picklistsRewritten: 0,
        notSent: 0,
        toPurge: 0,
        toDeactivate: 0,
      },
      {
        objectApiName: 'ServiceResource',
        fromFiles: 0,
        toInsert: 0,
        reusedByKeys: 0,
        reusedFromCatalog: 0,
        fieldsDropped: 0,
        picklistsRewritten: 0,
        notSent: 0,
        toPurge: 0,
        toDeactivate: 1,
      },
    ]);
    // In the order the load writes them, parents first; what only the purge reaches last.
    expect(plan.perObject.map((o) => o.objectApiName)).toEqual([
      ...report.perObject.map((o) => o.objectApiName),
      'ServiceResource',
    ]);
    // The load counted the same, object by object.
    for (const planned of plan.perObject) {
      const loaded = report.perObject.find((o) => o.objectApiName === planned.objectApiName);
      expect(loaded?.inserted ?? 0, planned.objectApiName).toBe(planned.toInsert);
      expect(loaded?.reused ?? 0, planned.objectApiName).toBe(
        planned.reusedByKeys + planned.reusedFromCatalog,
      );
      expect(loaded?.failed.length ?? 0, planned.objectApiName).toBe(planned.notSent);
      expect(report.purge.deleted[planned.objectApiName] ?? 0).toBe(planned.toPurge);
      expect(report.purge.deactivated[planned.objectApiName] ?? 0).toBe(planned.toDeactivate);
    }
    expect(plan.removals).toEqual(report.alignment.removals);
    expect(plan.perObject.reduce((sum, o) => sum + o.picklistsRewritten, 0)).toBe(
      report.alignment.adjustments.length,
    );
    expect(plan.excludedObjects).toEqual(report.alignment.excludedObjects);
    expect(plan.placeholders).toEqual(
      report.placeholders.map(({ placeholderId: _id, ...placeholder }) => placeholder),
    );
    expect(plan.requiredDefaults).toEqual(
      report.requiredDefaults.map(({ value: _value, ...fill }) => fill),
    );
    expect(plan.placeholders).toEqual([
      {
        objectApiName: 'Contact',
        field: 'Owner__c',
        placeholderObjectApiName: 'Owner__c',
        placeholderName: 'SANDFORGE-OWNER',
        affectedRecords: 2,
      },
    ]);
    expect(plan.requiredDefaults).toEqual([
      { objectApiName: 'Account', field: 'Rating__c', affectedRecords: 1 },
    ]);
    expect(plan.earlierLoads).toBe(1);
  });

  it('purges nothing on a pilot, as its load does not', async () => {
    const s = scenario();
    s.config.rootObjectApiName = 'Account';
    const sasDir = makeTmpDir();
    await earlierLoad(sasDir);

    const plan = await new FrozenDatasetLoader(makeDeps(refusingWriter(), sasDir, s)).planLoad(
      options(s.dataset, sasDir, { reload: true, pilot: {} }),
    );

    expect(plan.mode).toEqual({ pilot: true, reload: true });
    expect(plan.perObject.map((o) => o.toPurge + o.toDeactivate)).not.toContain(1);
    expect(plan.perObject.map((o) => o.objectApiName)).not.toContain('ServiceResource');
  });

  it('is refused as the load would be by an entry guard, before reading anything else', async () => {
    const s = scenario();
    const sasDir = makeTmpDir();
    const deps = makeDeps(refusingWriter(), sasDir, s);

    await expect(
      new FrozenDatasetLoader(deps).planLoad(options(s.dataset, sasDir, { orgTier: 'production' })),
    ).rejects.toThrow(LoadGuardError);
    expect(deps.orgAccess.describe).not.toHaveBeenCalled();
  });

  it('lists every required field the configuration leaves uncovered, as the load would', async () => {
    const s = scenario();
    s.config.requiredFieldDefaults = {};
    const sasDir = makeTmpDir();

    await expect(
      new FrozenDatasetLoader(makeDeps(refusingWriter(), sasDir, s)).planLoad(
        options(s.dataset, sasDir),
      ),
    ).rejects.toThrow(LoadConfigError);
  });

  it('counts the contacts of person accounts apart from those it would insert', async () => {
    const s = scenario();
    s.dataset.personContactSidecar = [
      { accountReferenceId: 'Account-000002', contactReferenceId: 'Contact-000002' },
    ];
    s.describes.Account.fields.push(field({ name: 'PersonContactId', type: 'reference' }));
    const sasDir = makeTmpDir();

    const plan = await new FrozenDatasetLoader(makeDeps(refusingWriter(), sasDir, s)).planLoad(
      options(s.dataset, sasDir),
    );

    expect(plan.personContacts).toBe(1);
    expect(plan.perObject.find((o) => o.objectApiName === 'Contact')?.toInsert).toBe(1);
  });
});
