import { describe, it, expect } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { SyncRunLinks, prepareSyncRows } from './syncRowPreparation.js';
import { targetWriteFieldsOf } from './targetWriteFields.js';
import type { SyncRecordTypes } from './syncRecordTypes.js';

/** Fake ids of the source org's records. */
const SOURCE_ACCOUNT_1 = '001000000000001AAA';
const SOURCE_ACCOUNT_2 = '001000000000002AAA';
const SOURCE_CONTACT_1 = '003000000000001AAA';

/** Fake record type ids: each org's own for the same two types. */
const SOURCE_BUSINESS = '0120000000000B1AAA';
const SOURCE_PERSON = '0120000000000P1AAA';
const SOURCE_RETIRED = '0120000000000R1AAA';
const TARGET_BUSINESS = '0120000000000B2AAA';
const TARGET_PERSON = '0120000000000P2AAA';

function objectConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
    ...overrides,
  };
}

/** A record type of the target's describe, as the running user sees it. */
function recordTypeInfo(developerName: string, recordTypeId: string, available = true) {
  return {
    active: true,
    available,
    defaultRecordTypeMapping: developerName === 'Business',
    developerName,
    master: false,
    name: developerName,
    recordTypeId,
    urls: {},
  };
}

/** The target's Account in an org with person accounts, as its describe gives it. */
function personAccountTarget(personAvailable = true) {
  return targetWriteFieldsOf({
    name: 'Account',
    fields: [
      { name: 'Id', createable: false, type: 'id' },
      { name: 'Name', createable: true, type: 'string' },
      { name: 'Phone', createable: true, type: 'phone' },
      { name: 'FirstName', createable: true, type: 'string' },
      { name: 'LastName', createable: true, type: 'string' },
      { name: 'Salutation', createable: true, type: 'picklist' },
      { name: 'PersonEmail', createable: true, type: 'email' },
      { name: 'Hobby__pc', createable: true, type: 'string' },
      { name: 'IsPersonAccount', createable: false, type: 'boolean' },
      { name: 'PersonContactId', createable: false, type: 'reference' },
      { name: 'ParentId', createable: true, type: 'reference' },
      { name: 'RecordTypeId', createable: true, type: 'reference' },
    ],
    recordTypeInfos: [
      recordTypeInfo('Business', TARGET_BUSINESS),
      recordTypeInfo('PersonAccount', TARGET_PERSON, personAvailable),
    ],
  });
}

/** Both orgs' record types, as `readSyncRecordTypes` gives them. */
const RECORD_TYPES: SyncRecordTypes = {
  mappings: [
    { sourceId: SOURCE_BUSINESS, targetId: TARGET_BUSINESS, developerName: 'Business' },
    { sourceId: SOURCE_PERSON, targetId: TARGET_PERSON, developerName: 'PersonAccount' },
  ],
  source: [
    { id: SOURCE_BUSINESS, name: 'Business', developerName: 'Business', sobjectType: 'Account' },
    {
      id: SOURCE_PERSON,
      name: 'Person Account',
      developerName: 'PersonAccount',
      sobjectType: 'Account',
    },
    { id: SOURCE_RETIRED, name: 'Retired', developerName: 'Retired', sobjectType: 'Account' },
  ],
  personTypes: new Set([TARGET_PERSON.slice(0, 15)]),
};

/** A business account and a person account, as `SELECT FIELDS(ALL)` reads them. */
const BUSINESS_ROW = {
  Id: SOURCE_ACCOUNT_1,
  Name: 'Acme',
  Phone: '+33 6 39 98 00 01',
  FirstName: null,
  LastName: null,
  Salutation: null,
  PersonEmail: null,
  Hobby__pc: null,
  IsPersonAccount: false,
  RecordTypeId: SOURCE_BUSINESS,
};
const PERSON_ROW = {
  Id: SOURCE_ACCOUNT_2,
  Name: 'Jane Roe',
  Phone: null,
  FirstName: 'Jane',
  LastName: 'Roe',
  Salutation: 'Ms.',
  PersonEmail: 'jane@example.invalid',
  Hobby__pc: 'Chess',
  IsPersonAccount: true,
  RecordTypeId: SOURCE_PERSON,
};

describe('prepareSyncRows — the kind of account', () => {
  it('sends a business account without the person fields and a person account without its name', () => {
    const rows = [BUSINESS_ROW, PERSON_ROW];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.held).toEqual([]);
    expect(prepared.payloads).toEqual([
      { Name: 'Acme', Phone: '+33 6 39 98 00 01', RecordTypeId: TARGET_BUSINESS },
      {
        Phone: null,
        FirstName: 'Jane',
        LastName: 'Roe',
        Salutation: 'Ms.',
        PersonEmail: 'jane@example.invalid',
        Hobby__pc: 'Chess',
        RecordTypeId: TARGET_PERSON,
      },
    ]);
  });

  it('sends a person account the target takes as a business one with its name and no person field', () => {
    // The target has person accounts, but the record type the row goes in
    // with is a business account's.
    const rows = [{ ...PERSON_ROW, RecordTypeId: SOURCE_BUSINESS }];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.payloads).toEqual([
      { Name: 'Jane Roe', Phone: null, RecordTypeId: TARGET_BUSINESS },
    ]);
  });

  it('reads the kind from the source row when a mapping leaves IsPersonAccount out', () => {
    const config = objectConfig({
      fieldMappings: [
        { sourceField: 'Name', targetField: 'Name', type: 'direct' },
        { sourceField: 'LastName', targetField: 'LastName', type: 'direct' },
      ],
    });

    const prepared = prepareSyncRows({
      config,
      records: [{ Name: 'Acme', LastName: null }],
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: [BUSINESS_ROW] },
    });

    expect(prepared.payloads).toEqual([{ Name: 'Acme' }]);
  });

  it('leaves the names of a contact alone', () => {
    const contact = { Id: SOURCE_CONTACT_1, FirstName: 'Jane', LastName: 'Roe' };

    const prepared = prepareSyncRows({
      config: objectConfig({ objectApiName: 'Contact' }),
      records: [contact],
      target: targetWriteFieldsOf({
        name: 'Contact',
        fields: [
          { name: 'FirstName', createable: true, type: 'string' },
          { name: 'LastName', createable: true, type: 'string' },
        ],
      }),
    });

    expect(prepared.payloads).toEqual([{ FirstName: 'Jane', LastName: 'Roe' }]);
  });
});

describe('prepareSyncRows — record types', () => {
  it('sends the target’s record type of the same object and API name', () => {
    const rows = [BUSINESS_ROW];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.payloads[0].RecordTypeId).toBe(TARGET_BUSINESS);
    expect([...prepared.settled[0]]).toEqual(['RecordTypeId']);
  });

  it('holds back a row whose record type has no counterpart in the target, and says it once', () => {
    const rows = [
      { ...BUSINESS_ROW, RecordTypeId: SOURCE_RETIRED },
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_2, RecordTypeId: SOURCE_RETIRED },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.payloads).toEqual([]);
    expect(prepared.held.map((h) => h.index)).toEqual([0, 1]);
    expect(prepared.notes).toEqual([
      'RECORD_TYPE_UNMAPPED: 2 Account records held back, not sent: their record type Retired ' +
        'has no active Account record type of that API name in the target org. Create or ' +
        'activate record type Retired on Account in the target org.',
    ]);
  });

  it('holds back a row whose record type the running user may not use in the target', () => {
    const rows = [PERSON_ROW];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(false),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.payloads).toEqual([]);
    expect(prepared.notes).toEqual([
      'RECORD_TYPE_UNAVAILABLE: 1 Account record uses record type PersonAccount, which the ' +
        'running user cannot use in the target org. Give the running user access to record ' +
        'type PersonAccount on Account, or map it to one they have. Held back, not sent.',
    ]);
  });

  it('sends a record type the target already holds as it is, when the orgs share their ids', () => {
    const rows = [{ ...BUSINESS_ROW, RecordTypeId: TARGET_BUSINESS }];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.payloads[0].RecordTypeId).toBe(TARGET_BUSINESS);
  });
});

describe('prepareSyncRows — the records the run wrote and refused', () => {
  const contactTarget = targetWriteFieldsOf({
    name: 'Contact',
    fields: [
      { name: 'LastName', createable: true, type: 'string' },
      { name: 'AccountId', createable: true, type: 'reference' },
      { name: 'OwnerId', createable: true, type: 'reference' },
    ],
  });
  const OWNER = '005000000000001AAA';

  it('points a lookup at the copy of a record the run wrote', () => {
    const links = new SyncRunLinks();
    links.noteWritten(SOURCE_ACCOUNT_1, '001000000000901AAA');
    const rows = [
      { Id: SOURCE_CONTACT_1, LastName: 'Roe', AccountId: SOURCE_ACCOUNT_1, OwnerId: OWNER },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig({ objectApiName: 'Contact' }),
      records: rows,
      target: contactTarget,
      run: { links, sources: rows },
    });

    expect(prepared.payloads).toEqual([
      { LastName: 'Roe', AccountId: '001000000000901AAA', OwnerId: OWNER },
    ]);
    expect([...prepared.settled[0]]).toEqual(['AccountId']);
  });

  it('holds back a row whose lookup names a record the run refused, and counts it', () => {
    const links = new SyncRunLinks();
    links.noteRefused(SOURCE_ACCOUNT_1, 'Account');
    links.noteWritten(SOURCE_ACCOUNT_2, '001000000000902AAA');
    const rows = [
      { Id: SOURCE_CONTACT_1, LastName: 'Roe', AccountId: SOURCE_ACCOUNT_1 },
      { Id: '003000000000002AAA', LastName: 'Doe', AccountId: SOURCE_ACCOUNT_1.slice(0, 15) },
      { Id: '003000000000003AAA', LastName: 'Poe', AccountId: SOURCE_ACCOUNT_2 },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig({ objectApiName: 'Contact' }),
      records: rows,
      target: contactTarget,
      run: { links, sources: rows },
    });

    expect(prepared.payloads).toEqual([{ LastName: 'Poe', AccountId: '001000000000902AAA' }]);
    expect(prepared.sentAt).toEqual([2]);
    expect(prepared.held).toEqual([
      {
        index: 0,
        reason: 'PARENT_REFUSED: the Account record its AccountId names was refused in this run.',
      },
      {
        index: 1,
        reason: 'PARENT_REFUSED: the Account record its AccountId names was refused in this run.',
      },
    ]);
    expect(prepared.notes).toEqual([
      'PARENT_REFUSED: 2 Contact records held back, not sent: the Account record their ' +
        'AccountId names was refused in this run, and written without it they would stand ' +
        'without their Account.',
    ]);
  });

  it('leaves a lookup at a record the run did not write as the source holds it', () => {
    const rows = [{ Id: SOURCE_CONTACT_1, LastName: 'Roe', AccountId: SOURCE_ACCOUNT_1 }];

    const prepared = prepareSyncRows({
      config: objectConfig({ objectApiName: 'Contact' }),
      records: rows,
      target: contactTarget,
      run: { links: new SyncRunLinks(), sources: rows },
    });

    expect(prepared.payloads).toEqual([{ LastName: 'Roe', AccountId: SOURCE_ACCOUNT_1 }]);
    expect([...prepared.settled[0]]).toEqual([]);
  });

  it('sends a delete its ids whatever the run refused', () => {
    const links = new SyncRunLinks();
    links.noteRefused(SOURCE_ACCOUNT_1, 'Account');

    const prepared = prepareSyncRows({
      config: objectConfig({ objectApiName: 'Contact', operation: 'delete' }),
      records: [{ Id: SOURCE_CONTACT_1 }],
      target: contactTarget,
      run: { links, sources: [{ Id: SOURCE_CONTACT_1, AccountId: SOURCE_ACCOUNT_1 }] },
    });

    expect(prepared.payloads).toEqual([{ Id: SOURCE_CONTACT_1 }]);
    expect(prepared.held).toEqual([]);
  });
});

describe('SyncRunLinks', () => {
  it('finds a record by either form of its id, and forgets a refusal once it is written', () => {
    const links = new SyncRunLinks();
    links.noteRefused(SOURCE_ACCOUNT_1, 'Account');
    expect(links.refusedObjectOf(SOURCE_ACCOUNT_1.slice(0, 15))).toBe('Account');

    links.noteWritten(SOURCE_ACCOUNT_1, '001000000000901AAA');
    expect(links.refusedObjectOf(SOURCE_ACCOUNT_1)).toBeUndefined();
    expect(links.targetOf(SOURCE_ACCOUNT_1.slice(0, 15))).toBe('001000000000901AAA');

    // Written, a record is never taken back for refused.
    links.noteRefused(SOURCE_ACCOUNT_1, 'Account');
    expect(links.refusedObjectOf(SOURCE_ACCOUNT_1)).toBeUndefined();
  });
});
