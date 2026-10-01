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
  FrozenLoadCancelledError,
  FrozenLoadFailedError,
  type FrozenDatasetLoaderDeps,
  type FrozenLoadOptions,
} from './FrozenDatasetLoader.js';
import { loadCreatedRecords, loadRecordsInfo, loadToRemove } from './loadRecords.js';
import type { FrozenDataset, PersonContactLink } from './types.js';
import type {
  FrozenDmlWriter,
  FrozenLoadConfig,
  FrozenLoadProgressEvent,
  TargetObjectDescribe,
} from './loadTypes.js';

/*
 * A dataset with person accounts. The platform writes a person account's
 * contact itself as it takes the account, and links the two by the account's
 * PersonContactId, which no insert and no update sets: the load never sends
 * the contact's row, and maps it onto the contact the platform wrote, so that
 * what points at it is written against that one.
 */

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-person-accounts-test-'));
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
  payload: Array<Record<string, unknown>> | string[];
}

/** Key prefixes of the ids the writer answers with. */
const KEY_PREFIX: Record<string, string> = {
  Abc__c: 'a00',
  Account: '001',
  Branch__c: 'a01',
  Case: '500',
  Contact: '003',
};

/**
 * Writer whose inserts answer with record ids — fifteen letters and digits,
 * the only ids a removal takes — numbered in the order written, refusing the
 * insert of each record whose `Name` is in `refused`.
 */
function makeWriter(calls: DmlCall[], refused: readonly string[] = []): FrozenDmlWriter {
  let counter = 0;
  return {
    insert: vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'insert', objectApiName, payload: records });
        return records.map((record) =>
          refused.includes(String(record.Name))
            ? {
                success: false,
                errors: [`FIELD_CUSTOM_VALIDATION_EXCEPTION: ${String(record.Name)}`],
              }
            : {
                id: `${KEY_PREFIX[objectApiName]}${String(++counter).padStart(12, '0')}`,
                success: true,
                errors: [],
              },
        );
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

/** The target's describe of each object: every field the dataset holds, createable and nillable. */
function describeFromDataset(dataset: FrozenDataset): Record<string, TargetObjectDescribe> {
  const describes: Record<string, TargetObjectDescribe> = {};
  for (const objectData of dataset.objects) {
    const names = new Set(objectData.records.flatMap((record) => Object.keys(record.fields)));
    describes[objectData.objectApiName] = {
      name: objectData.objectApiName,
      fields: [...names].map((name) => ({
        name,
        type: 'string',
        createable: true,
        nillable: true,
        defaultedOnCreate: false,
      })),
    };
  }
  return describes;
}

type Query = (orgId: string, soql: string) => Promise<Array<Record<string, unknown>>>;

interface MakeDepsOptions {
  dataset: FrozenDataset;
  describes?: Record<string, TargetObjectDescribe>;
  writer?: FrozenDmlWriter;
  queryImpl?: Query;
  config?: FrozenLoadConfig;
  /** The target's record types by DeveloperName; absent, every one resolves. */
  recordTypes?: Record<string, string | null>;
}

function makeDeps(options: MakeDepsOptions): FrozenDatasetLoaderDeps & { sasDir: string } {
  const sasDir = makeTmpDir();
  const describes = options.describes ?? describeFromDataset(options.dataset);
  return {
    orgAccess: {
      query: vi.fn(options.queryImpl ?? (async () => [])),
      describe: vi.fn(async (_org: string, objectApiName: string) => {
        const describe = describes[objectApiName];
        if (!describe) throw new Error(`sObject ${objectApiName} not found`);
        return describe;
      }),
      picklistValues: vi.fn(async () => []),
    },
    writer: options.writer ?? makeWriter([]),
    guard: new ProductionGuard(),
    mockDetector: { areCalloutsMocked: vi.fn(async () => true) },
    recordTypeResolver: {
      resolveByDeveloperName: vi.fn(async (_org: string, _object: string, developerName: string) =>
        options.recordTypes && developerName in options.recordTypes
          ? (options.recordTypes[developerName] ?? null)
          : '012000000000001',
      ),
    },
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

/** The person account the writer inserts first, by its id. */
const PERSON = '001000000000001';
/** The contact the platform wrote with it. */
const PLATFORM_CONTACT = '003PLATFORM0001';

const PERSON_RECORD_TYPE = { name: 'Person Account', developerName: 'PersonAccount' };

const link = (n: number): PersonContactLink => ({
  accountReferenceId: `Account-00000${n}`,
  contactReferenceId: `Contact-00000${n}`,
});

/**
 * A person account and its contact; a business account and its contact; and
 * a case on the person account, naming its contact.
 */
function personAccountDataset(): FrozenDataset {
  return {
    datasetVersion: '1.0.0',
    objects: [
      {
        objectApiName: 'Account',
        records: [
          {
            referenceId: 'Account-000001',
            fields: {
              Name: 'Jane Doe',
              LastName: 'Doe',
              RecordTypeId: 'Person Account',
              PersonContactId: 'Contact-000001',
            },
          },
          { referenceId: 'Account-000002', fields: { Name: 'Anon Account', PersonContactId: '' } },
        ],
      },
      {
        objectApiName: 'Contact',
        records: [
          {
            referenceId: 'Contact-000001',
            fields: { LastName: 'Doe', AccountId: 'Account-000001' },
          },
          {
            referenceId: 'Contact-000002',
            fields: { LastName: 'Roe', AccountId: 'Account-000002' },
          },
        ],
      },
      {
        objectApiName: 'Case',
        records: [
          {
            referenceId: 'Case-000001',
            fields: { Subject: 'Broken', AccountId: 'Account-000001', ContactId: 'Contact-000001' },
          },
        ],
      },
    ],
    recordTypes: { Account: [PERSON_RECORD_TYPE] },
    personContactSidecar: [link(1)],
  };
}

/**
 * The target's answer to the read of what the platform wrote with each
 * account: the contact of each account `written` names, and none of any
 * other account asked — a business account's.
 */
function platformContacts(written: Readonly<Record<string, string>>): Query {
  return async (_org, soql) => {
    if (!soql.includes('PersonContactId FROM Account')) return [];
    return [...soql.matchAll(/'([^']+)'/g)].map(([, id]) => ({
      Id: id,
      PersonContactId: written[id] ?? null,
    }));
  };
}

/** The records the writer was sent for one object's inserts. */
function insertedOf(
  calls: readonly DmlCall[],
  objectApiName: string,
): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.op === 'insert' && c.objectApiName === objectApiName)
    .flatMap((c) => c.payload as Array<Record<string, unknown>>);
}

/** The status and words of the line that ended an object's turn, or a phase. */
function endOf(
  progress: readonly FrozenLoadProgressEvent[],
  phase: FrozenLoadProgressEvent['phase'],
  objectName?: string,
): Array<[string, string]> {
  return progress
    .filter((e) => e.phase === phase && e.status !== 'started' && e.objectName === objectName)
    .map((e) => [e.status, e.message]);
}

/** The loads the sas records, the last first, as a removal and a reload read them. */
const recordedLoads = (sasDir: string) =>
  new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }).recordedLoads();

describe('FrozenDatasetLoader, person accounts', () => {
  it("never sends a person account's contact, and writes what points at it against the one the platform wrote with the account", async () => {
    const dataset = personAccountDataset();
    const calls: DmlCall[] = [];
    const progress: FrozenLoadProgressEvent[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      queryImpl: platformContacts({ [PERSON]: PLATFORM_CONTACT }),
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
    );

    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual([
      'insert:Account',
      'insert:Contact',
      'insert:Case',
    ]);
    expect(insertedOf(calls, 'Account')[0]).not.toHaveProperty('PersonContactId');
    expect(insertedOf(calls, 'Contact').map((c) => c.LastName)).toEqual(['Roe']);
    expect(insertedOf(calls, 'Case')[0]).toMatchObject({
      AccountId: PERSON,
      ContactId: PLATFORM_CONTACT,
    });
    expect(report.personContact).toEqual({ restored: 1, unresolved: [] });
    expect(report.perObject.find((o) => o.objectApiName === 'Contact')).toMatchObject({
      fromFiles: 2,
      inserted: 1,
      reused: 1,
      failed: [],
    });
    expect(report.pass2).toEqual({ resolved: 0, unresolved: [] });
    expect(report.status).toBe('completed');
    expect(endOf(progress, 'insert', 'Contact')).toEqual([
      [
        'done',
        'Contact: 1 inserted, 1 reused, 0 duplicates skipped, 0 failed, 1 linked to the contact ' +
          'the platform wrote with its person account',
      ],
    ]);
    expect(endOf(progress, 'personcontact')).toEqual([
      [
        'done',
        'Person contacts: 1 linked to the contact the platform wrote with their account, 0 not linked',
      ],
    ]);
  });

  it('expects the contact it linked among the contacts in the target, and leaves it to its account in a removal', async () => {
    const dataset = personAccountDataset();
    const deps = makeDeps({
      dataset,
      writer: makeWriter([]),
      queryImpl: platformContacts({ [PERSON]: PLATFORM_CONTACT }),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    const [load] = await recordedLoads(deps.sasDir);
    expect(load.mapping.get('Contact-000001')).toBe(PLATFORM_CONTACT);
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Contact).toMatchObject({ fromFiles: 2, excluded: 0, expected: 2 });
    // Never among what the load created: the platform deletes it with its
    // account, and refuses it deleted on its own.
    expect(loadCreatedRecords(load)).toEqual([
      { objectApiName: 'Case', ids: ['500000000000004'] },
      { objectApiName: 'Contact', ids: ['003000000000003'] },
      { objectApiName: 'Account', ids: ['001000000000002', PERSON] },
    ]);
    // Nor among the linked records a removal says it leaves in the org.
    expect(loadRecordsInfo(load).linked).toBe(0);
  });

  it('says of each contact it could not link why: its account not loaded, or held by the target as a business account, with the record type issue that made it one', async () => {
    const person = (n: number, recordType: string) => ({
      referenceId: `Account-00000${n}`,
      fields: {
        Name: `P${n}`,
        LastName: `P${n}`,
        RecordTypeId: recordType,
        PersonContactId: `Contact-00000${n}`,
      },
    });
    const contact = (n: number) => ({
      referenceId: `Contact-00000${n}`,
      fields: { LastName: `P${n}`, AccountId: `Account-00000${n}` },
    });
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Account',
          records: [person(1, 'Person Account'), person(2, 'Person Account'), person(3, 'Gone')],
        },
        { objectApiName: 'Contact', records: [contact(1), contact(2), contact(3)] },
      ],
      recordTypes: { Account: [PERSON_RECORD_TYPE, { name: 'Gone', developerName: 'Gone' }] },
      personContactSidecar: [link(1), link(2), link(3)],
    };
    const calls: DmlCall[] = [];
    const progress: FrozenLoadProgressEvent[] = [];
    const deps = makeDeps({
      dataset,
      // The first account is refused; the platform writes no contact with the others.
      writer: makeWriter(calls, ['P1']),
      queryImpl: platformContacts({}),
      recordTypes: { Gone: null },
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
    );

    // Not one contact is sent.
    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual(['insert:Account']);
    const businessAccount =
      'the target holds the account as a business account, with no contact of its own';
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
          cause: 'not-a-person-account',
          detail: `${businessAccount}: its record type there is no person account's`,
        },
        {
          ...link(3),
          cause: 'not-a-person-account',
          detail: `${businessAccount}: RecordType Gone not found in target org — RecordTypeId dropped`,
        },
      ],
    });
    const notInTheTarget =
      "Not written: a person account's contact goes in with its account, and the target holds " +
      'that account as a business account';
    expect(report.perObject.find((o) => o.objectApiName === 'Contact')).toEqual({
      objectApiName: 'Contact',
      fromFiles: 3,
      inserted: 0,
      reused: 0,
      skippedDuplicates: [],
      failed: [
        {
          objectApiName: 'Contact',
          referenceId: 'Contact-000001',
          errors: [
            "Not written: a person account's contact goes in with its account, which the load did not write",
          ],
        },
        { objectApiName: 'Contact', referenceId: 'Contact-000002', errors: [notInTheTarget] },
        { objectApiName: 'Contact', referenceId: 'Contact-000003', errors: [notInTheTarget] },
      ],
    });
    expect(report.status).toBe('completed-with-errors');
    // Never sent, none of them was refused: an exclusion of their own.
    const contract = readCountingContract(new SasPathGuard(repoRoot), report.contractPath);
    expect(contract.objects.Contact).toEqual({
      fromFiles: 3,
      exclusionReasons: { 'person-contact-not-linked': 3 },
      excluded: 3,
      added: 0,
      expected: 0,
    });
    expect(endOf(progress, 'insert', 'Contact')).toEqual([
      [
        'error',
        'Contact: 0 inserted, 0 reused, 0 duplicates skipped, 3 failed, 3 not written: a person ' +
          "account's contact goes in with its account",
      ],
    ]);
    expect(endOf(progress, 'personcontact')).toEqual([
      [
        'error',
        'Person contacts: 0 linked to the contact the platform wrote with their account, 3 not linked',
      ],
    ]);
  });

  it('asks a target without person accounts nothing of them, and says so of every link', async () => {
    const dataset = personAccountDataset();
    const describes = describeFromDataset(dataset);
    // Only an org with person accounts describes the account's lookup at its contact.
    describes.Account.fields = describes.Account.fields.filter((f) => f.name !== 'PersonContactId');
    const queries: string[] = [];
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      describes,
      writer: makeWriter(calls),
      queryImpl: async (_org, soql) => {
        queries.push(soql);
        return [];
      },
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(queries.filter((soql) => soql.includes('PersonContactId'))).toEqual([]);
    expect(report.personContact.unresolved).toEqual([
      {
        ...link(1),
        cause: 'not-a-person-account',
        detail:
          'the target org has no person accounts: it holds the account as a business account, ' +
          'with no contact of its own',
      },
    ]);
    // Never sent all the same: the case goes without its contact, and the
    // cycle pass says so.
    expect(insertedOf(calls, 'Contact').map((c) => c.LastName)).toEqual(['Roe']);
    expect(insertedOf(calls, 'Case')[0]).not.toHaveProperty('ContactId');
    expect(report.pass2.unresolved).toEqual([
      expect.objectContaining({
        objectApiName: 'Case',
        field: 'ContactId',
        cause: 'target-not-loaded',
      }),
    ]);
  });

  it('writes the accounts before the contacts, though the other objects make the contacts ready first', async () => {
    // The contact object's turn links the person accounts' contacts: before
    // the accounts' turn, it would find none of them in the target.
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Account',
          records: [
            {
              referenceId: 'Account-000001',
              fields: {
                Name: 'Jane Doe',
                Branch__c: 'Branch__c-000001',
                PersonContactId: 'Contact-000001',
              },
            },
          ],
        },
        {
          objectApiName: 'Branch__c',
          records: [{ referenceId: 'Branch__c-000001', fields: { Name: 'North' } }],
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
      personContactSidecar: [link(1)],
    };
    const calls: DmlCall[] = [];
    const progress: FrozenLoadProgressEvent[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      // The branch goes first: the account is the second record written.
      queryImpl: platformContacts({ '001000000000002': PLATFORM_CONTACT }),
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
    );

    expect(
      progress
        .filter((e) => e.phase === 'insert' && e.status !== 'started')
        .map((e) => e.objectName),
    ).toEqual(['Branch__c', 'Account', 'Contact']);
    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual([
      'insert:Branch__c',
      'insert:Account',
    ]);
    expect(report.personContact).toEqual({ restored: 1, unresolved: [] });
  });

  it('writes the accounts before the contacts inside a cycle, though a lookup the accounts require puts another object first', async () => {
    // Inside a cycle, what a required lookup points at goes first, and the
    // rest by name: the contacts, needing nothing there, went before the
    // accounts, which waited for their desk.
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Account',
          records: [
            {
              referenceId: 'Account-000001',
              fields: {
                Name: 'Jane Doe',
                Desk__c: 'Desk__c-000001',
                PersonContactId: 'Contact-000001',
              },
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
            {
              referenceId: 'Contact-000002',
              fields: { LastName: 'Roe', AccountId: 'Account-000001' },
            },
          ],
        },
        {
          objectApiName: 'Desk__c',
          records: [
            {
              referenceId: 'Desk__c-000001',
              fields: { Name: 'North', Owner__c: 'Contact-000002' },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [link(1)],
    };
    const describes = describeFromDataset(dataset);
    describes.Account.fields = describes.Account.fields.map((f) =>
      f.name === 'Desk__c' ? { ...f, nillable: false, referenceTo: ['Desk__c'] } : f,
    );
    const progress: FrozenLoadProgressEvent[] = [];
    const deps = makeDeps({
      dataset,
      describes,
      writer: makeWriter([]),
      // The desk goes first: the account is the second record written.
      queryImpl: platformContacts({ '001000000000002': PLATFORM_CONTACT }),
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }),
    );

    expect(
      progress
        .filter((e) => e.phase === 'insert' && e.status !== 'started')
        .map((e) => e.objectName),
    ).toEqual(['Desk__c', 'Account', 'Contact']);
    expect(report.personContact).toEqual({ restored: 1, unresolved: [] });
  });

  it("orders nothing by an account's lookup at its contact: what the accounts need goes in after them, not around a cycle", async () => {
    // Taken for a dependency, the lookup put the accounts and the contacts in
    // one cycle with what lay between them, written by name: a record that
    // needed an account went before it, and waited for the second pass.
    const dataset: FrozenDataset = {
      datasetVersion: '1.0.0',
      objects: [
        {
          objectApiName: 'Abc__c',
          records: [
            {
              referenceId: 'Abc__c-000001',
              fields: { Name: 'Desk', Account__c: 'Account-000001' },
            },
          ],
        },
        {
          objectApiName: 'Account',
          records: [
            {
              referenceId: 'Account-000001',
              fields: { Name: 'Jane Doe', PersonContactId: 'Contact-000001' },
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
            {
              referenceId: 'Contact-000002',
              fields: { LastName: 'Roe', Desk__c: 'Abc__c-000001' },
            },
          ],
        },
      ],
      recordTypes: {},
      personContactSidecar: [link(1)],
    };
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      queryImpl: platformContacts({ [PERSON]: PLATFORM_CONTACT }),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual([
      'insert:Account',
      'insert:Abc__c',
      'insert:Contact',
    ]);
    expect(insertedOf(calls, 'Abc__c')[0].Account__c).toBe(PERSON);
    expect(report.pass2).toEqual({ resolved: 0, unresolved: [] });
  });

  it('links the contact of a person account a reload finds by its identity keys', async () => {
    const dataset = personAccountDataset();
    dataset.objects[0].records[0].fields.ExternalId__c = 'P-1';
    const found = '001EXISTING0001';
    const contactOfFound = '003EXISTING0001';
    const calls: DmlCall[] = [];
    const contacts = platformContacts({ [found]: contactOfFound });
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      config: { identityKeys: { Account: ['ExternalId__c'] } },
      queryImpl: async (org, soql) =>
        soql.startsWith('SELECT Id, ExternalId__c FROM Account')
          ? [{ Id: found, ExternalId__c: 'P-1' }]
          : contacts(org, soql),
    });

    const report = await new FrozenDatasetLoader(deps).load(
      makeOptions(deps, dataset, { reload: true }),
    );

    expect(insertedOf(calls, 'Account').map((a) => a.Name)).toEqual(['Anon Account']);
    expect(insertedOf(calls, 'Case')[0]).toMatchObject({
      AccountId: found,
      ContactId: contactOfFound,
    });
    expect(report.personContact).toEqual({ restored: 1, unresolved: [] });
  });

  it("never sends a contact the dataset flags a person account's though the sidecar names none, and says when the dataset does not hold its account", async () => {
    const dataset = personAccountDataset();
    dataset.personContactSidecar = [];
    const contacts = dataset.objects[1].records;
    contacts[0].fields.IsPersonAccount = true;
    contacts.push({
      referenceId: 'Contact-000003',
      fields: { LastName: 'Poe', IsPersonAccount: 'true', AccountId: '' },
    });
    const calls: DmlCall[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      queryImpl: platformContacts({ [PERSON]: PLATFORM_CONTACT }),
    });

    const report = await new FrozenDatasetLoader(deps).load(makeOptions(deps, dataset));

    expect(insertedOf(calls, 'Contact').map((c) => c.LastName)).toEqual(['Roe']);
    expect(insertedOf(calls, 'Case')[0].ContactId).toBe(PLATFORM_CONTACT);
    expect(report.personContact).toEqual({
      restored: 1,
      unresolved: [
        {
          accountReferenceId: '',
          contactReferenceId: 'Contact-000003',
          cause: 'record-not-loaded',
          detail: 'its person account is not in the dataset',
        },
      ],
    });
    expect(report.perObject.find((o) => o.objectApiName === 'Contact')?.failed).toEqual([
      {
        objectApiName: 'Contact',
        referenceId: 'Contact-000003',
        errors: [
          "Not written: a person account's contact goes in with its account, which the dataset does not hold",
        ],
      },
    ]);
  });

  it("fails on the contact object's turn when the contacts the platform wrote cannot be read, keeping what it wrote", async () => {
    const dataset = personAccountDataset();
    const progress: FrozenLoadProgressEvent[] = [];
    const deps = makeDeps({
      dataset,
      writer: makeWriter([]),
      queryImpl: async (_org, soql) => {
        if (soql.includes('PersonContactId FROM Account')) {
          throw new Error('INVALID_SESSION_ID: Session expired or invalid');
        }
        return [];
      },
    });

    const error: unknown = await new FrozenDatasetLoader(deps)
      .load(makeOptions(deps, dataset, { onProgress: (e) => progress.push(e) }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FrozenLoadFailedError);
    expect((error as Error).message).toContain('created 2 record(s) (Account: 2)');
    expect(endOf(progress, 'insert', 'Contact')).toEqual([
      [
        'error',
        'Contact: 0 inserted, 0 reused, 0 duplicates skipped, 0 failed, 1 not inserted: the load ' +
          'failed — INVALID_SESSION_ID: Session expired or invalid',
      ],
    ]);
    const load = loadToRemove(await recordedLoads(deps.sasDir));
    expect(load && loadCreatedRecords(load)).toEqual([
      { objectApiName: 'Account', ids: ['001000000000002', PERSON] },
    ]);
    expect(fs.existsSync(path.join(deps.sasDir, 'counting-contract.json'))).toBe(false);
  });

  it("stops before the contacts when the cancel comes as the person accounts' contacts are read, and writes no contract", async () => {
    const dataset = personAccountDataset();
    const stop = new AbortController();
    const calls: DmlCall[] = [];
    const contacts = platformContacts({ [PERSON]: PLATFORM_CONTACT });
    const deps = makeDeps({
      dataset,
      writer: makeWriter(calls),
      queryImpl: async (org, soql) => {
        if (soql.includes('PersonContactId FROM Account')) stop.abort();
        return contacts(org, soql);
      },
    });

    const error: unknown = await new FrozenDatasetLoader(deps)
      .load(makeOptions(deps, dataset, { signal: stop.signal }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FrozenLoadCancelledError);
    expect(calls.map((c) => `${c.op}:${c.objectApiName}`)).toEqual(['insert:Account']);
    expect(
      (error as FrozenLoadCancelledError).written.perObject.find(
        (o) => o.objectApiName === 'Contact',
      ),
    ).toMatchObject({ inserted: 0, reused: 1, notInserted: 1 });
    expect(fs.existsSync(path.join(deps.sasDir, 'counting-contract.json'))).toBe(false);
    // The mapping kept says the contact goes with its account.
    const [load] = await recordedLoads(deps.sasDir);
    expect(load.personContacts).toEqual({ 'Contact-000001': 'Account-000001' });
    expect(loadRecordsInfo(load).linked).toBe(0);
  });
});
