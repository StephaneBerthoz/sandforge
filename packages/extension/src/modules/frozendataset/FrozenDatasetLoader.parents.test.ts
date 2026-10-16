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
import type { FrozenDataset, FrozenObjectData } from './types.js';
import type {
  FrozenDmlWriter,
  FrozenLoadConfig,
  TargetFieldDescribe,
  TargetObjectDescribe,
} from './loadTypes.js';

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-parents-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

/** What the target was sent: per object, every payload of every insert. */
type Sent = Map<string, Array<Record<string, unknown>>>;

/**
 * A writer whose target refuses, on a validation rule, every record whose
 * `Name` reads `Refused`, skips as a duplicate one whose `Name` reads
 * `Duplicate`, and takes the rest with ids of its own.
 */
function makeWriter(sent: Sent): FrozenDmlWriter {
  let counter = 0;
  return {
    insert: vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        sent.set(objectApiName, [...(sent.get(objectApiName) ?? []), ...records]);
        return records.map((record) => {
          if (record.Name === 'Refused') {
            return {
              success: false,
              errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Accounts need a rating'],
            };
          }
          if (record.Name === 'Duplicate') {
            return { success: false, errors: ['DUPLICATE_VALUE: duplicate value found'] };
          }
          return { id: `REAL-${objectApiName}-${++counter}`, success: true, errors: [] };
        });
      },
    ),
    update: vi.fn(
      async (_org: string, _objectApiName: string, records: Array<Record<string, unknown>>) =>
        records.map((r) => ({ id: String(r.Id), success: true, errors: [] })),
    ),
    delete: vi.fn(async (_org: string, _objectApiName: string, ids: string[]) =>
      ids.map((id) => ({ id, success: true, errors: [] })),
    ),
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

function lookup(name: string, to: string, required = false): TargetFieldDescribe {
  return field({ name, type: 'reference', referenceTo: [to], nillable: !required });
}

/** A target describing each object with the fields its records carry, plus `extra`. */
function describesOf(
  objects: readonly FrozenObjectData[],
  extra: Record<string, TargetFieldDescribe[]>,
): Record<string, TargetObjectDescribe> {
  const describes: Record<string, TargetObjectDescribe> = {};
  for (const objectData of objects) {
    const names = new Set(objectData.records.flatMap((r) => Object.keys(r.fields)));
    const fields = extra[objectData.objectApiName] ?? [];
    describes[objectData.objectApiName] = {
      name: objectData.objectApiName,
      fields: [
        ...[...names]
          .filter((name) => !fields.some((f) => f.name === name))
          .map((name) => field({ name })),
        ...fields,
      ],
    };
  }
  return describes;
}

function datasetOf(objects: FrozenObjectData[]): FrozenDataset {
  return { datasetVersion: '1.0.0', objects, recordTypes: {}, personContactSidecar: [] };
}

function makeDeps(
  writer: FrozenDmlWriter,
  sasDir: string,
  describes: Record<string, TargetObjectDescribe>,
  config: FrozenLoadConfig = {},
): FrozenDatasetLoaderDeps {
  return {
    orgAccess: {
      query: vi.fn(async () => []),
      describe: vi.fn(async (_org: string, objectApiName: string) => {
        const describe = describes[objectApiName];
        if (!describe) throw new Error(`sObject ${objectApiName} not found`);
        return describe;
      }),
      picklistValues: vi.fn(async () => []),
    },
    writer,
    guard: new ProductionGuard(),
    mockDetector: { areCalloutsMocked: vi.fn(async () => true) },
    recordTypeResolver: { resolveByDeveloperName: vi.fn(async () => null) },
    mappingStore: new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }),
    config,
    sasGuard: new SasPathGuard(repoRoot),
  };
}

function options(dataset: FrozenDataset, sasDir: string): FrozenLoadOptions {
  return { orgId: '00D-target', orgTier: 'development', dataset, sasDir };
}

describe('FrozenDatasetLoader — records whose parent excludedObjects leaves out', () => {
  /**
   * Two participants of a policy the configuration excludes, their lookup at
   * it cleared as every lookup at a record the dataset does not hold, a note
   * on the first that cannot go in without it, and an account that can.
   */
  function participants(): {
    dataset: FrozenDataset;
    describes: Record<string, TargetObjectDescribe>;
  } {
    const objects: FrozenObjectData[] = [
      {
        objectApiName: 'Account',
        records: [{ referenceId: 'Account-000001', fields: { Name: 'Holder' } }],
      },
      {
        objectApiName: 'InsurancePolicyParticipant',
        records: [
          {
            referenceId: 'InsurancePolicyParticipant-000001',
            fields: {
              Role: 'Insured',
              InsurancePolicyId: '',
              PrimaryParticipantAccountId: 'Account-000001',
            },
          },
          {
            referenceId: 'InsurancePolicyParticipant-000002',
            fields: {
              Role: 'Payer',
              InsurancePolicyId: '',
              PrimaryParticipantAccountId: 'Account-000001',
            },
          },
        ],
      },
      {
        objectApiName: 'ParticipantNote__c',
        records: [
          {
            referenceId: 'ParticipantNote__c-000001',
            fields: { Body__c: 'Called', Participant__c: 'InsurancePolicyParticipant-000001' },
          },
        ],
      },
    ];
    return {
      dataset: datasetOf(objects),
      describes: describesOf(objects, {
        InsurancePolicyParticipant: [
          lookup('InsurancePolicyId', 'InsurancePolicy', true),
          lookup('PrimaryParticipantAccountId', 'Account'),
        ],
        ParticipantNote__c: [lookup('Participant__c', 'InsurancePolicyParticipant', true)],
      }),
    };
  }

  it('leaves them out, with what cannot go in without them, and asks no placeholder for the parent', async () => {
    // Run for real, the extraction said the participants "cannot be loaded
    // without the InsurancePolicy named by InsurancePolicyId, which
    // excludedObjects leaves out", and the load then refused to start until
    // a placeholder was declared for that lookup.
    const { dataset, describes } = participants();
    const sasDir = makeTmpDir();
    const sent: Sent = new Map();

    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter(sent), sasDir, describes, { excludedObjects: ['InsurancePolicy'] }),
    ).load(options(dataset, sasDir));

    expect([...sent.keys()]).toEqual(['Account']);
    expect(report.status).toBe('completed');
    expect(report.heldForExcludedParents).toEqual([
      {
        objectApiName: 'InsurancePolicyParticipant',
        count: 2,
        note:
          '2 left out: InsurancePolicyId names an InsurancePolicy record, which excludedObjects ' +
          'leaves out — declare a placeholder in requiredLookupPlaceholders to load them',
      },
      {
        objectApiName: 'ParticipantNote__c',
        count: 1,
        note: '1 left out: Participant__c names a record left out for the InsurancePolicy excludedObjects leaves out',
      },
    ]);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.InsurancePolicyParticipant).toMatchObject({
      exclusionReasons: { 'excluded-parent': 2 },
      expected: 0,
    });
    expect(contract.objects.ParticipantNote__c.exclusionReasons).toEqual({ 'excluded-parent': 1 });
  });

  it('says in the preview that it would leave them out, counted among the records not sent', async () => {
    const { dataset, describes } = participants();
    const sasDir = makeTmpDir();

    const plan = await new FrozenDatasetLoader(
      makeDeps(makeWriter(new Map()), sasDir, describes, { excludedObjects: ['InsurancePolicy'] }),
    ).planLoad(options(dataset, sasDir));

    expect(plan.placeholders).toEqual([]);
    expect(
      plan.perObject.find((o) => o.objectApiName === 'InsurancePolicyParticipant'),
    ).toMatchObject({ fromFiles: 2, toInsert: 0, notSent: 2 });
    expect(plan.heldForExcludedParents?.map((h) => [h.objectApiName, h.count])).toEqual([
      ['InsurancePolicyParticipant', 2],
      ['ParticipantNote__c', 1],
    ]);
  });

  it('points them at a placeholder the configuration declares for that lookup', async () => {
    const { dataset, describes } = participants();
    const sasDir = makeTmpDir();
    const sent: Sent = new Map();

    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter(sent), sasDir, describes, {
        excludedObjects: ['InsurancePolicy'],
        requiredLookupPlaceholders: {
          'InsurancePolicyParticipant.InsurancePolicyId': { name: 'SANDFORGE-POLICY' },
        },
      }),
    ).load(options(dataset, sasDir));

    expect(report.heldForExcludedParents).toBeUndefined();
    expect(sent.get('InsurancePolicy')).toEqual([{ Name: 'SANDFORGE-POLICY' }]);
    const placeholder = report.placeholders[0]?.placeholderId;
    expect(placeholder).toMatch(/^REAL-InsurancePolicy-/);
    expect(sent.get('InsurancePolicyParticipant')?.map((p) => p.InsurancePolicyId)).toEqual([
      placeholder,
      placeholder,
    ]);
  });

  it('still asks a placeholder for a required lookup at an object the configuration keeps', async () => {
    const { dataset, describes } = participants();
    const sasDir = makeTmpDir();

    await expect(
      new FrozenDatasetLoader(makeDeps(makeWriter(new Map()), sasDir, describes)).load(
        options(dataset, sasDir),
      ),
    ).rejects.toThrow(LoadConfigError);
  });
});

describe('FrozenDatasetLoader — records whose parent the target refused', () => {
  /**
   * An account the target refuses, three contacts under it and the relation
   * of one to another account the target takes; a contact under that one,
   * and a contact under no account.
   */
  function accounts(): { dataset: FrozenDataset; describes: Record<string, TargetObjectDescribe> } {
    const objects: FrozenObjectData[] = [
      {
        objectApiName: 'Account',
        records: [
          { referenceId: 'Account-000001', fields: { Name: 'Refused' } },
          { referenceId: 'Account-000002', fields: { Name: 'Taken' } },
        ],
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
          {
            referenceId: 'Contact-000003',
            fields: { LastName: 'Six', AccountId: 'Account-000001' },
          },
          {
            referenceId: 'Contact-000004',
            fields: { LastName: 'Kept', AccountId: 'Account-000002' },
          },
          { referenceId: 'Contact-000005', fields: { LastName: 'Alone', AccountId: '' } },
        ],
      },
      {
        objectApiName: 'AccountContactRelation',
        records: [
          {
            referenceId: 'AccountContactRelation-000001',
            fields: { ContactId: 'Contact-000001', AccountId: 'Account-000002', IsDirect: false },
          },
        ],
      },
    ];
    return {
      dataset: datasetOf(objects),
      describes: describesOf(objects, {
        Contact: [lookup('AccountId', 'Account')],
        AccountContactRelation: [
          lookup('ContactId', 'Contact', true),
          lookup('AccountId', 'Account', true),
        ],
      }),
    };
  }

  it('holds back the contacts of an account the target refused, and their relations in turn', async () => {
    // Run for real, the account a validation rule refused left 130 contacts
    // written as private contacts, and the target refused each relation of
    // theirs: "You can't associate a private contact with an account".
    const { dataset, describes } = accounts();
    const sasDir = makeTmpDir();
    const sent: Sent = new Map();

    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter(sent), sasDir, describes),
    ).load(options(dataset, sasDir));

    expect(sent.get('Contact')?.map((c) => c.LastName)).toEqual(['Kept', 'Alone']);
    expect(sent.get('AccountContactRelation')).toBeUndefined();
    const contacts = report.perObject.find((o) => o.objectApiName === 'Contact');
    expect(contacts).toMatchObject({ inserted: 2 });
    expect(contacts?.failed.map((f) => f.referenceId)).toEqual([
      'Contact-000001',
      'Contact-000002',
      'Contact-000003',
    ]);
    expect(contacts?.failed[0].errors).toEqual([
      'PARENT_REFUSED: the Account record its AccountId names was refused in this load, and ' +
        'written without it this record would stand without its Account.',
    ]);
    expect(
      report.perObject.find((o) => o.objectApiName === 'AccountContactRelation')?.failed[0].errors,
    ).toEqual([
      'PARENT_REFUSED: the Contact record its ContactId names was refused in this load, and ' +
        'written without it this record would stand without its Contact.',
    ]);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Contact.exclusionReasons).toEqual({ 'parent-refused': 3 });
    expect(contract.objects.Account.exclusionReasons).toEqual({ 'dml-failed': 1 });
    expect(contract.objects.AccountContactRelation.exclusionReasons).toEqual({
      'parent-refused': 1,
    });
  });

  it('writes the lookup at a record of the load it wrote, and leaves empty one the dataset leaves empty', async () => {
    const { dataset, describes } = accounts();
    const sasDir = makeTmpDir();
    const sent: Sent = new Map();

    await new FrozenDatasetLoader(makeDeps(makeWriter(sent), sasDir, describes)).load(
      options(dataset, sasDir),
    );

    const [kept, alone] = sent.get('Contact') ?? [];
    expect(kept.AccountId).toMatch(/^REAL-Account-/);
    expect(alone).not.toHaveProperty('AccountId');
  });

  it('writes the contacts of an account the target skipped as a duplicate, and names the lookup it left empty', async () => {
    // The target holds such an account already: its contacts are no orphans
    // of a refusal, and go in. Their lookup stays empty, which the contract
    // keeps for the verification to count.
    const { dataset, describes } = accounts();
    dataset.objects[0].records[0].fields.Name = 'Duplicate';
    const sasDir = makeTmpDir();
    const sent: Sent = new Map();

    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter(sent), sasDir, describes),
    ).load(options(dataset, sasDir));

    expect(sent.get('Contact')).toHaveLength(5);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Contact.parentNotLoaded).toEqual({
      AccountId: ['Contact-000001', 'Contact-000002', 'Contact-000003'],
    });
  });
});
