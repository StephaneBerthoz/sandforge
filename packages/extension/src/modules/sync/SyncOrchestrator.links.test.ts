import { describe, it, expect } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';
import type { SyncRecordTypes } from './syncRecordTypes.js';

/*
 * Two fake orgs: a source holding business and person accounts under record
 * types of its own, contacts under them, cases under the contacts; and a
 * target with person accounts, record types of the same names under other
 * ids — one closed to the running user — and a field on the account it
 * requires that the source leaves empty on one row. Its writer refuses what
 * Salesforce refused on a real client sandbox: a person field on a business
 * account, a name on a person account, a record type id it does not hold or
 * the user may not use, a required field left empty, a lookup at a record it
 * does not hold.
 */

const SOURCE = {
  business: '0120000000000B1AAA',
  person: '0120000000000P1AAA',
  partner: '0120000000000X1AAA',
  retired: '0120000000000R1AAA',
};
const TARGET = {
  business: '0120000000000B2AAA',
  person: '0120000000000P2AAA',
  partner: '0120000000000X2AAA',
};

const RECORD_TYPES: SyncRecordTypes = {
  mappings: [
    { sourceId: SOURCE.business, targetId: TARGET.business, developerName: 'Business' },
    { sourceId: SOURCE.person, targetId: TARGET.person, developerName: 'PersonAccount' },
    { sourceId: SOURCE.partner, targetId: TARGET.partner, developerName: 'Partner' },
  ],
  source: [
    { id: SOURCE.business, name: 'Business', developerName: 'Business', sobjectType: 'Account' },
    { id: SOURCE.person, name: 'Person', developerName: 'PersonAccount', sobjectType: 'Account' },
    { id: SOURCE.partner, name: 'Partner', developerName: 'Partner', sobjectType: 'Account' },
    { id: SOURCE.retired, name: 'Retired', developerName: 'Retired', sobjectType: 'Account' },
  ],
  personTypes: new Set([TARGET.person.slice(0, 15)]),
};

/** The fields only a person account holds, on the target's account. */
const PERSON_FIELDS = ['FirstName', 'LastName', 'Hobby__pc'];

const recordType = (developerName: string, recordTypeId: string, available: boolean) => ({
  active: true,
  available,
  defaultRecordTypeMapping: developerName === 'Business',
  developerName,
  master: false,
  name: developerName,
  recordTypeId,
  urls: {},
});

const DESCRIBES: Record<string, TargetWriteFields> = {
  Account: targetWriteFieldsOf({
    name: 'Account',
    fields: [
      { name: 'Id', createable: false, type: 'id' },
      { name: 'Name', createable: true, type: 'string', nillable: true },
      { name: 'FirstName', createable: true, type: 'string', nillable: true },
      { name: 'LastName', createable: true, type: 'string', nillable: true },
      { name: 'Hobby__pc', createable: true, type: 'string', nillable: true },
      {
        name: 'Region__c',
        createable: true,
        type: 'string',
        nillable: false,
        defaultedOnCreate: false,
        length: 20,
      },
      { name: 'Code__c', createable: true, type: 'string', nillable: true, unique: true },
      { name: 'IsPersonAccount', createable: false, type: 'boolean' },
      { name: 'PersonContactId', createable: false, type: 'reference' },
      { name: 'RecordTypeId', createable: true, type: 'reference', nillable: true },
    ],
    recordTypeInfos: [
      recordType('Business', TARGET.business, true),
      recordType('PersonAccount', TARGET.person, true),
      recordType('Partner', TARGET.partner, false),
    ],
  }),
  Contact: targetWriteFieldsOf({
    name: 'Contact',
    fields: [
      { name: 'LastName', createable: true, type: 'string', nillable: false },
      { name: 'AccountId', createable: true, type: 'reference', nillable: true },
    ],
  }),
  Case: targetWriteFieldsOf({
    name: 'Case',
    fields: [
      { name: 'Subject', createable: true, type: 'string', nillable: true },
      { name: 'ContactId', createable: true, type: 'reference', nillable: true },
    ],
  }),
};

const SOURCE_ROWS: Record<string, Array<Record<string, unknown>>> = {
  Account: [
    // Written: a business account, a person account.
    business('001000000000001AAA', 'Acme', 'EU', SOURCE.business),
    {
      Id: '001000000000003AAA',
      Name: 'Jane Roe',
      FirstName: 'Jane',
      LastName: 'Roe',
      Hobby__pc: 'Chess',
      Region__c: 'EU',
      IsPersonAccount: true,
      RecordTypeId: SOURCE.person,
      CreatedDate: '2026-01-01T00:00:00.000Z',
    },
    // Refused by the target: its required region left empty.
    business('001000000000002AAA', 'Globex', null, SOURCE.business),
    // Held back: a record type closed to the user, one with no counterpart.
    business('001000000000004AAA', 'Initech', 'EU', SOURCE.partner),
    business('001000000000005AAA', 'Hooli', 'EU', SOURCE.retired),
    // Refused by the target: a code Acme takes first, a code it holds already.
    { ...business('001000000000006AAA', 'Acme twin', 'EU', SOURCE.business), Code__c: 'acme' },
    { ...business('001000000000007AAA', 'Taken', 'EU', SOURCE.business), Code__c: 'TAKEN' },
  ],
  Contact: [
    { Id: '003000000000001AAA', LastName: 'Under Acme', AccountId: '001000000000001AAA' },
    { Id: '003000000000002AAA', LastName: 'Under Globex', AccountId: '001000000000002AAA' },
    { Id: '003000000000003AAA', LastName: 'Under Initech', AccountId: '001000000000004AAA' },
    { Id: '003000000000004AAA', LastName: 'On their own', AccountId: null },
    { Id: '003000000000005AAA', LastName: 'Under the twin', AccountId: '001000000000006AAA' },
    // Under an account the target holds under the same code: linked to it.
    { Id: '003000000000006AAA', LastName: 'Under Taken', AccountId: '001000000000007AAA' },
  ],
  Case: [
    { Id: '500000000000001AAA', Subject: 'From Globex', ContactId: '003000000000002AAA' },
    { Id: '500000000000002AAA', Subject: 'From Acme', ContactId: '003000000000001AAA' },
  ],
};

function business(Id: string, Name: string, Region: string | null, RecordTypeId: string) {
  return {
    Id,
    Name,
    Code__c: Name === 'Acme' ? 'ACME' : null,
    FirstName: null,
    LastName: null,
    Hobby__pc: null,
    Region__c: Region,
    IsPersonAccount: false,
    RecordTypeId,
    CreatedDate: '2026-01-01T00:00:00.000Z',
  };
}

/** The target org: what it holds, and an insert that refuses as Salesforce does. */
function targetOrg() {
  const held = new Map<string, Record<string, unknown>>([
    ['001000000000800AAA', { object: 'Account', Name: 'Theirs', Code__c: 'taken' }],
  ]);
  let next = 900;
  /** How many accounts hold a code, regardless of case, as a unique text field compares. */
  /** The ids of the accounts that hold a code, regardless of case, as a unique text field compares. */
  const holders = (code: unknown): string[] =>
    [...held.entries()]
      .filter(
        ([, r]) =>
          r.object === 'Account' &&
          typeof r.Code__c === 'string' &&
          typeof code === 'string' &&
          r.Code__c.toLowerCase() === code.toLowerCase(),
      )
      .map(([id]) => id);
  const holding = (code: unknown): number => holders(code).length;
  /** The records the target held before the call being answered. */
  let before = new Set<string>();
  const refuse = (record: Record<string, unknown>, object: string): string | undefined => {
    const fields = DESCRIBES[object];
    const bad = Object.keys(record).filter((f) => !fields.creatable.has(f));
    if (bad.length > 0) return `INVALID_FIELD_FOR_INSERT_UPDATE: ${bad.join(', ')}`;
    if (object === 'Account') {
      const type = record.RecordTypeId as string | undefined;
      const info = fields.recordTypes?.find((t) => t.recordTypeId === type);
      if (type !== undefined && (!info || !info.available)) {
        return 'INVALID_CROSS_REFERENCE_KEY: Record Type ID: this ID value isn’t valid for the user';
      }
      const person = type === TARGET.person;
      const personFields = PERSON_FIELDS.filter((f) => f in record);
      if (!person && personFields.length > 0) {
        return `INVALID_FIELD_FOR_INSERT_UPDATE: Account: bad field names on insert/update call: ${personFields.join(', ')}`;
      }
      if (person && 'Name' in record) {
        return 'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: Name';
      }
      if (record.Region__c === null || record.Region__c === undefined) {
        return 'REQUIRED_FIELD_MISSING: Required fields are missing: [Region__c]';
      }
      // Salesforce names the record it holds; one written earlier in the
      // same call, it does not.
      const [holder] = holders(record.Code__c);
      if (holder !== undefined) {
        const named = before.has(holder) ? holder.slice(0, 15) : '<unknown>';
        return `DUPLICATE_VALUE: duplicate value found: Code__c duplicates value on record with id: ${named}`;
      }
    }
    for (const lookup of ['AccountId', 'ContactId']) {
      const value = record[lookup];
      if (typeof value === 'string' && !held.has(value)) {
        return 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id';
      }
    }
    return undefined;
  };
  /**
   * An insert, answered as the run's writer answers it: a duplicate's refusal
   * that names a record of the target carries it (`existingId`).
   */
  const insert = async (
    object: string,
    records: Record<string, unknown>[],
  ): Promise<OperationOutcome[]> => {
    before = new Set(held.keys());
    return records.map((record) => {
      const refusal = refuse(record, object);
      if (refusal) {
        const named = /on record with id: ([A-Za-z0-9]{15})$/.exec(refusal)?.[1];
        const existingId = [...held.keys()].find((id) => id.slice(0, 15) === named);
        return { success: false, errors: [refusal], ...(existingId ? { existingId } : {}) };
      }
      const id = `${object === 'Account' ? '001' : object === 'Contact' ? '003' : '500'}000000000${next++}AAA`;
      held.set(id, { ...record, object });
      return { id, success: true, errors: [] };
    });
  };
  /** What a simulation asks in place of the write: how many accounts hold each code. */
  const find = async (
    _org: string,
    _objectConfig: SyncObjectConfig,
    field: string,
    keys: readonly (string | number | boolean)[],
  ): Promise<ReadonlyMap<string, number>> =>
    new Map(
      field === 'Code__c'
        ? keys.flatMap((key) => {
            const count = holding(key);
            return count > 0 ? [[String(key).toLowerCase(), count] as const] : [];
          })
        : [],
    );
  return { held, insert, find };
}

function objectConfig(objectApiName: string, insertOrder: number): SyncObjectConfig {
  return {
    objectApiName,
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder,
  };
}

const CONFIG: SyncConfig = {
  id: 'config-links',
  name: 'Accounts, contacts, cases',
  description: '',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  direction: 'source_to_target',
  mode: 'full',
  objects: [objectConfig('Account', 0), objectConfig('Contact', 1), objectConfig('Case', 2)],
  conflictStrategy: 'source_wins',
  enableRollback: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function orchestrator(
  target: ReturnType<typeof targetOrg>,
  recordTypes: () => Promise<SyncRecordTypes> = async () => RECORD_TYPES,
) {
  const unused = async (): Promise<OperationOutcome[]> => [];
  const describeTargetFields = async (object: string) => DESCRIBES[object];
  return new SyncOrchestrator({
    dataSync: new DataSync({
      insert: (object, records) => target.insert(object, records),
      update: unused,
      upsert: unused,
      delete: unused,
      describeTargetFields,
    }),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: async (_org, objectConfig) => SOURCE_ROWS[objectConfig.objectApiName],
    queryTarget: async () => [],
    findInTarget: target.find,
    describeTargetFields,
    recordTypes,
  });
}

describe('SyncOrchestrator — the records a run writes and refuses, object after object', () => {
  it('writes every account it can, holds back the rows under those it cannot, and leaves no orphan', async () => {
    const target = targetOrg();

    const result = await orchestrator(target).execute(CONFIG);

    expect(
      result.objectResults.map((r) => [
        r.objectApiName,
        r.processed,
        r.success,
        r.failed,
        r.skipped,
      ]),
    ).toEqual([
      ['Account', 7, 2, 4, 1],
      ['Contact', 6, 3, 3, 0],
      ['Case', 2, 1, 1, 0],
    ]);
    // Every contact and case written points at a record of the target.
    const written = [...target.held.values()].filter((r) => r.Name !== 'Theirs');
    for (const record of written) {
      for (const lookup of ['AccountId', 'ContactId']) {
        const value = record[lookup];
        if (value !== undefined && value !== null)
          expect(target.held.has(value as string)).toBe(true);
      }
    }
    const underAcme = written.find((r) => r.LastName === 'Under Acme');
    expect(target.held.get(underAcme?.AccountId as string)?.Name).toBe('Acme');
    // The account the target refused as a duplicate of its own is linked to
    // it, and the contact under it follows it there.
    const underTaken = written.find((r) => r.LastName === 'Under Taken');
    expect(target.held.get(underTaken?.AccountId as string)?.Name).toBe('Theirs');
    expect(result.objectResults[0].errors).toContain(
      'LINKED_TO_EXISTING: 1 Account record linked to an existing record, not written: the ' +
        'target refused it as a duplicate of a record it holds and named it (DUPLICATE_VALUE: ' +
        'duplicate value found: Code__c duplicates value on record with id: 001000000000800); ' +
        'what the run writes under it points at that record.',
    );
    // Linked, it is not one the run created, and no removal of the run takes it.
    expect(result.status).toBe('partial');
    const contacts = result.objectResults[1].errors.join(' ');
    expect(contacts).toMatch(/PARENT_REFUSED: 3 Contact records held back, not sent: the Account/);
    const cases = result.objectResults[2].errors.join(' ');
    expect(cases).toMatch(/PARENT_REFUSED: 1 Case record held back, not sent: the Contact/);
  });

  it('says in the simulation, object by object, what the run then refuses', async () => {
    const simulated = await orchestrator(targetOrg()).simulate(CONFIG);
    const run = await orchestrator(targetOrg()).execute(CONFIG);

    expect(simulated.error).toBeUndefined();
    expect(simulated.objects.map((o) => [o.objectApiName, o.insert, o.refused, o.skipped])).toEqual(
      run.objectResults.map((r) => [r.objectApiName, r.success, r.failed, r.skipped]),
    );
    const accounts = simulated.objects[0].notes.join(' ');
    expect(accounts).toContain(
      'RECORD_TYPE_UNAVAILABLE: 1 Account record uses record type Partner',
    );
    expect(accounts).toContain('RECORD_TYPE_UNMAPPED: 1 Account record held back');
    expect(accounts).toContain(
      '1 record(s) leave Region__c empty, which the target requires: it refuses them',
    );
    expect(accounts).toContain(
      'LINKED_TO_EXISTING: 1 record(s) hold a Code__c the target keeps unique, which a record ' +
        'of the target holds already: it refuses them as duplicates (DUPLICATE_VALUE) and names ' +
        'that record, which the run links them to',
    );
    expect(accounts).toContain(
      '1 record(s) hold a Code__c the target keeps unique, which a record sent before them ' +
        'holds (1): it refuses them (DUPLICATE_VALUE).',
    );
  });

  it('stops before the first record that carries a record type when the record types cannot be read', async () => {
    const target = targetOrg();
    let asked = 0;
    const failing = orchestrator(target, async () => {
      asked++;
      throw new Error('INVALID_SESSION_ID: Session expired or invalid');
    });

    await expect(failing.execute(CONFIG)).rejects.toThrow(
      /record types of the two orgs could not be read, so none of these records was sent: INVALID_SESSION_ID/,
    );
    // The target holds its own account alone.
    expect([...target.held.values()].map((r) => r.Name)).toEqual(['Theirs']);
    expect(asked).toBe(1);
  });

  it('reads no record type for objects whose records carry none', async () => {
    let asked = 0;
    const contactsOnly = { ...CONFIG, objects: [objectConfig('Contact', 0)] };

    await orchestrator(targetOrg(), async () => {
      asked++;
      return RECORD_TYPES;
    }).execute(contactsOnly);

    expect(asked).toBe(0);
  });
});
