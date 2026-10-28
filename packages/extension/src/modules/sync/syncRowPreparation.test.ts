import { describe, it, expect } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { SyncRunLinks, prepareSyncRows } from './syncRowPreparation.js';
import { targetWriteFieldsOf } from './targetWriteFields.js';
import type { SyncRecordTypes } from './syncRecordTypes.js';
import { orgCurrenciesOf, type RunCurrencies } from '../../core/common/recordCurrencies.js';

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

  it('holds back a package’s record type the target holds only as the org’s own, and says why', () => {
    // Retired, here, was installed by package `ns`; the target has an
    // Account record type of that DeveloperName, made in the org itself.
    const rows = [{ ...BUSINESS_ROW, RecordTypeId: SOURCE_RETIRED }];
    const recordTypes: SyncRecordTypes = {
      ...RECORD_TYPES,
      source: RECORD_TYPES.source.map((t) =>
        t.id === SOURCE_RETIRED ? { ...t, namespacePrefix: 'ns' } : t,
      ),
      target: [
        {
          id: TARGET_BUSINESS,
          name: 'Retired',
          developerName: 'Retired',
          namespacePrefix: null,
          sobjectType: 'Account',
        },
      ],
    };

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes },
    });

    expect(prepared.payloads).toEqual([]);
    expect(prepared.notes).toEqual([
      'RECORD_TYPE_UNMAPPED: 1 Account record held back, not sent: their record type ' +
        'ns__Retired has no active Account record type of that API name in the target org. ' +
        "The target org's Retired carries its DeveloperName under another namespace, and a " +
        'record type is mapped to one of the same namespace only. Create or activate record ' +
        'type ns__Retired on Account in the target org.',
    ]);
  });

  it('names a package’s record type closed to the running user by its row, whatever the describe calls it', () => {
    const rows = [PERSON_ROW];
    const recordTypes: SyncRecordTypes = {
      ...RECORD_TYPES,
      target: [
        {
          id: TARGET_PERSON,
          name: 'Person Account',
          developerName: 'PersonAccount',
          namespacePrefix: 'ns',
          sobjectType: 'Account',
        },
      ],
    };

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(false),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes },
    });

    expect(prepared.notes[0]).toContain(
      'uses record type ns__PersonAccount (PersonAccount), which the running user cannot use',
    );
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

describe('prepareSyncRows — lookups at rows of the same write', () => {
  const SOURCE_ACCOUNT_3 = '001000000000003AAA';

  it('leaves out a lookup at a row of the same write, for a second write to set', () => {
    const rows = [
      // Named by its fifteen-character id, as a formula or a report holds it.
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_1, ParentId: SOURCE_ACCOUNT_2.slice(0, 15) },
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_2, Name: 'Globex', ParentId: null },
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_3, Name: 'Initech', ParentId: SOURCE_ACCOUNT_1 },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.payloads.map((p) => 'ParentId' in p && p.ParentId)).toEqual([
      false,
      null,
      false,
    ]);
    expect(prepared.deferred).toEqual([
      { index: 0, field: 'ParentId', parent: SOURCE_ACCOUNT_2.slice(0, 15) },
      { index: 2, field: 'ParentId', parent: SOURCE_ACCOUNT_1 },
    ]);
    expect(prepared.held).toEqual([]);
  });

  it('defers both lookups of two rows that name each other, a loop no order breaks', () => {
    const rows = [
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_1, ParentId: SOURCE_ACCOUNT_2 },
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_2, Name: 'Globex', ParentId: SOURCE_ACCOUNT_1 },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.sentAt).toEqual([0, 1]);
    expect(prepared.deferred.map((d) => [d.index, d.parent])).toEqual([
      [0, SOURCE_ACCOUNT_2],
      [1, SOURCE_ACCOUNT_1],
    ]);
  });

  it('holds back the rows under a row of the same write it holds back, and the rows under those', () => {
    const rows = [
      // Its record type has no counterpart in the target: held back.
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_1, RecordTypeId: SOURCE_RETIRED, ParentId: null },
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_2, Name: 'Globex', ParentId: SOURCE_ACCOUNT_1 },
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_3, Name: 'Initech', ParentId: SOURCE_ACCOUNT_2 },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.payloads).toEqual([]);
    expect(prepared.deferred).toEqual([]);
    expect(prepared.held.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(prepared.notes).toContain(
      'PARENT_REFUSED: 2 Account records held back, not sent: the Account record their ' +
        'ParentId names was refused in this run, and written without it they would stand ' +
        'without their Account.',
    );
  });

  it('holds back no row under a held-back row an earlier run wrote a copy of', () => {
    const links = new SyncRunLinks(
      new Map([[SOURCE_ACCOUNT_1.slice(0, 15), '001000000000901AAA']]),
    );
    const rows = [
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_1, RecordTypeId: SOURCE_RETIRED, ParentId: null },
      { ...BUSINESS_ROW, Id: SOURCE_ACCOUNT_2, Name: 'Globex', ParentId: SOURCE_ACCOUNT_1 },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: personAccountTarget(),
      run: { links, sources: rows, recordTypes: RECORD_TYPES },
    });

    expect(prepared.held.map((h) => h.index)).toEqual([0]);
    expect(prepared.sentAt).toEqual([1]);
    expect(prepared.deferred).toEqual([{ index: 1, field: 'ParentId', parent: SOURCE_ACCOUNT_1 }]);
  });

  it('points an update at the rows its ids name, deferring none', () => {
    const rows = [
      { Id: SOURCE_ACCOUNT_1, Name: 'Acme', ParentId: SOURCE_ACCOUNT_2 },
      { Id: SOURCE_ACCOUNT_2, Name: 'Globex' },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig({ operation: 'update' }),
      records: rows,
      target: personAccountTarget(),
      run: { links: new SyncRunLinks(), sources: rows },
    });

    expect(prepared.deferred).toEqual([]);
    expect(prepared.payloads[0]).toMatchObject({
      Id: SOURCE_ACCOUNT_1,
      ParentId: SOURCE_ACCOUNT_2,
    });
  });
});

describe('prepareSyncRows — currencies', () => {
  /** The target's opportunity in an org with several currencies, as its describe gives it. */
  const OPPORTUNITY_TARGET = targetWriteFieldsOf({
    name: 'Opportunity',
    fields: [
      { name: 'Id', createable: false, type: 'id' },
      { name: 'Name', createable: true, type: 'string' },
      { name: 'CurrencyIsoCode', createable: true, type: 'picklist' },
      { name: 'Amount', createable: true, type: 'currency', precision: 18, scale: 2 },
      { name: 'ExpectedRevenue', createable: false, type: 'currency', precision: 18, scale: 2 },
    ],
  });
  /** The source holds GBP at 0.79 to its corporate USD; the target USD and EUR, no GBP. */
  const CURRENCIES: RunCurrencies = {
    source: orgCurrenciesOf([
      { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
      { IsoCode: 'EUR', ConversionRate: 0.92, IsActive: true },
      { IsoCode: 'GBP', ConversionRate: 0.79, IsActive: true },
    ])!,
    target: orgCurrenciesOf([
      { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
      { IsoCode: 'EUR', ConversionRate: 0.9, IsActive: true },
    ])!,
  };
  const deal = (n: number, currency: string, amount: number) => ({
    Id: `006000000000${n}00AAA`,
    Name: `Deal ${n}`,
    CurrencyIsoCode: currency,
    Amount: amount,
  });

  it("sends a row in a currency the target lacks in its corporate currency, its amounts converted at the source's rates, and says so", () => {
    const records = [deal(1, 'GBP', 5000.55), deal(2, 'EUR', 100)];

    const prepared = prepareSyncRows({
      config: objectConfig({ objectApiName: 'Opportunity' }),
      records,
      target: OPPORTUNITY_TARGET,
      run: { links: new SyncRunLinks(), sources: records, currencies: CURRENCIES },
    });

    expect(prepared.payloads).toEqual([
      { Name: 'Deal 1', CurrencyIsoCode: 'USD', Amount: 6329.81 },
      { Name: 'Deal 2', CurrencyIsoCode: 'EUR', Amount: 100 },
    ]);
    // Said apart from the notes, which say what was held back: the panel says
    // them in the user's language.
    expect(prepared.notes).toEqual([]);
    expect(prepared.currencies).toEqual([
      {
        objectApiName: 'Opportunity',
        from: 'GBP',
        to: 'USD',
        chosenBy: 'corporate',
        rows: 1,
        fields: ['Amount'],
      },
    ]);
  });

  it('sends the currency as read when the run has no currencies of the two orgs', () => {
    const records = [deal(1, 'GBP', 5000.55)];

    const prepared = prepareSyncRows({
      config: objectConfig({ objectApiName: 'Opportunity' }),
      records,
      target: OPPORTUNITY_TARGET,
      run: { links: new SyncRunLinks(), sources: records },
    });

    expect(prepared.payloads[0]).toMatchObject({ CurrencyIsoCode: 'GBP', Amount: 5000.55 });
    expect(prepared.notes).toEqual([]);
  });

  it("converts an opportunity's products as their opportunity was converted, the target taking no currency of theirs", () => {
    // Sent as read, the products of a GBP opportunity written in USD kept
    // their GBP prices, and the opportunity's amount, their sum, with them.
    const lineTarget = targetWriteFieldsOf({
      name: 'OpportunityLineItem',
      fields: [
        { name: 'Id', createable: false, type: 'id' },
        {
          name: 'OpportunityId',
          createable: true,
          type: 'reference',
          referenceTo: ['Opportunity'],
        },
        { name: 'CurrencyIsoCode', createable: false, type: 'picklist' },
        { name: 'UnitPrice', createable: true, type: 'currency', precision: 18, scale: 2 },
        { name: 'Quantity', createable: true, type: 'double', precision: 18, scale: 2 },
      ],
    });
    const deals = [deal(1, 'GBP', 158), deal(2, 'EUR', 100)];
    const currencyChangesById = new Map();
    prepareSyncRows({
      config: objectConfig({ objectApiName: 'Opportunity' }),
      records: deals,
      target: OPPORTUNITY_TARGET,
      run: {
        links: new SyncRunLinks(),
        sources: deals,
        currencies: CURRENCIES,
        currencyChangesById,
      },
    });
    const lines = [
      {
        Id: '00k000000000001AAA',
        OpportunityId: deals[0].Id,
        CurrencyIsoCode: 'GBP',
        UnitPrice: 79,
        Quantity: 2,
      },
      {
        Id: '00k000000000002AAA',
        OpportunityId: deals[1].Id,
        CurrencyIsoCode: 'EUR',
        UnitPrice: 50,
        Quantity: 2,
      },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig({ objectApiName: 'OpportunityLineItem' }),
      records: lines,
      target: lineTarget,
      run: {
        links: new SyncRunLinks(),
        sources: lines,
        currencies: CURRENCIES,
        currencyChangesById,
      },
    });

    expect(prepared.payloads.map((payload) => payload['UnitPrice'])).toEqual([100, 50]);
    expect(prepared.payloads[0]).not.toHaveProperty('CurrencyIsoCode');
    expect(prepared.currencies).toEqual([
      {
        objectApiName: 'OpportunityLineItem',
        from: 'GBP',
        to: 'USD',
        chosenBy: 'parent',
        rows: 1,
        fields: ['UnitPrice'],
      },
    ]);
  });

  it("names among a product's converted fields only those it sends, its total price left out", () => {
    // The currency line listed TotalPrice, converted and then left out of the
    // write, which takes one of the two prices.
    const lineTarget = targetWriteFieldsOf({
      name: 'OpportunityLineItem',
      fields: [
        { name: 'Id', createable: false, type: 'id' },
        {
          name: 'OpportunityId',
          createable: true,
          type: 'reference',
          referenceTo: ['Opportunity'],
        },
        { name: 'CurrencyIsoCode', createable: false, type: 'picklist' },
        { name: 'UnitPrice', createable: true, type: 'currency', precision: 18, scale: 2 },
        { name: 'TotalPrice', createable: true, type: 'currency', precision: 18, scale: 2 },
        { name: 'Quantity', createable: true, type: 'double', precision: 18, scale: 2 },
      ],
    });
    const deals = [deal(1, 'GBP', 158)];
    const currencyChangesById = new Map();
    prepareSyncRows({
      config: objectConfig({ objectApiName: 'Opportunity' }),
      records: deals,
      target: OPPORTUNITY_TARGET,
      run: {
        links: new SyncRunLinks(),
        sources: deals,
        currencies: CURRENCIES,
        currencyChangesById,
      },
    });
    const lines = [
      {
        Id: '00k000000000001AAA',
        OpportunityId: deals[0].Id,
        CurrencyIsoCode: 'GBP',
        UnitPrice: 79,
        TotalPrice: 158,
        Quantity: 2,
      },
    ];

    const prepared = prepareSyncRows({
      config: objectConfig({ objectApiName: 'OpportunityLineItem' }),
      records: lines,
      target: lineTarget,
      run: {
        links: new SyncRunLinks(),
        sources: lines,
        currencies: CURRENCIES,
        currencyChangesById,
      },
    });

    expect(prepared.payloads[0]).not.toHaveProperty('TotalPrice');
    expect(prepared.payloads[0]['UnitPrice']).toBe(100);
    expect(prepared.currencies.map((entry) => entry.fields)).toEqual([['UnitPrice']]);
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

  it('names no copy the run deleted, its own or an earlier run’s, by either form of its id', () => {
    const earlierCopy = '001000000000902AAA';
    const links = new SyncRunLinks(new Map([[SOURCE_ACCOUNT_1.slice(0, 15), earlierCopy]]));
    links.noteWritten(SOURCE_ACCOUNT_2, '001000000000903AAA');
    expect(links.targetOf(SOURCE_ACCOUNT_1)).toBe(earlierCopy);

    links.noteDeleted([earlierCopy.slice(0, 15), '001000000000903AAA']);

    expect(links.targetOf(SOURCE_ACCOUNT_1)).toBeUndefined();
    expect(links.targetOf(SOURCE_ACCOUNT_2)).toBeUndefined();
    // The deleted copy no longer stands in for a record this run refused.
    links.noteRefused(SOURCE_ACCOUNT_1, 'Account');
    expect(links.refusedObjectOf(SOURCE_ACCOUNT_1)).toBe('Account');
  });
});

describe('prepareSyncRows — lookups at an object written later in a cycle', () => {
  /** The target's Account, with a lookup at its primary contact. */
  const accountTarget = (required = false) =>
    targetWriteFieldsOf({
      name: 'Account',
      fields: [
        { name: 'Name', createable: true, type: 'string' },
        {
          name: 'Primary_Contact__c',
          createable: true,
          type: 'reference',
          referenceTo: ['Contact'],
          nillable: !required,
        },
        { name: 'ParentId', createable: true, type: 'reference', referenceTo: ['Account'] },
      ],
    });
  const rows = [
    { Id: SOURCE_ACCOUNT_1, Name: 'Acme', Primary_Contact__c: SOURCE_CONTACT_1, ParentId: null },
  ];

  it('leaves the lookup out of the row it creates, for the run to set once the contacts are written', () => {
    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: accountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, later: new Set(['Contact']) },
    });

    expect(prepared.payloads).toEqual([{ Name: 'Acme', ParentId: null }]);
    expect(prepared.deferredAcross).toEqual([
      { index: 0, field: 'Primary_Contact__c', parent: SOURCE_CONTACT_1 },
    ]);
    expect(prepared.deferred).toEqual([]);
  });

  it('sends the lookup as before with no object of the cycle written after it', () => {
    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: accountTarget(),
      run: { links: new SyncRunLinks(), sources: rows },
    });

    expect(prepared.payloads[0].Primary_Contact__c).toBe(SOURCE_CONTACT_1);
    expect(prepared.deferredAcross).toEqual([]);
  });

  it('keeps a lookup the target requires, which the row could not go without', () => {
    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: accountTarget(true),
      run: { links: new SyncRunLinks(), sources: rows, later: new Set(['Contact']) },
    });

    expect(prepared.payloads[0].Primary_Contact__c).toBe(SOURCE_CONTACT_1);
    expect(prepared.deferredAcross).toEqual([]);
  });

  it('names the copy an earlier run wrote rather than wait for one', () => {
    const TARGET_CONTACT = '003000000000901AAA';
    const links = new SyncRunLinks(new Map([[SOURCE_CONTACT_1.slice(0, 15), TARGET_CONTACT]]));

    const prepared = prepareSyncRows({
      config: objectConfig(),
      records: rows,
      target: accountTarget(),
      run: { links, sources: rows, later: new Set(['Contact']) },
    });

    expect(prepared.payloads[0].Primary_Contact__c).toBe(TARGET_CONTACT);
    expect(prepared.deferredAcross).toEqual([]);
  });

  it('waits for nothing in an update, which finds its record by the id both orgs share', () => {
    const prepared = prepareSyncRows({
      config: objectConfig({ operation: 'update' }),
      records: rows,
      target: accountTarget(),
      run: { links: new SyncRunLinks(), sources: rows, later: new Set(['Contact']) },
    });

    expect(prepared.payloads[0].Primary_Contact__c).toBe(SOURCE_CONTACT_1);
    expect(prepared.deferredAcross).toEqual([]);
  });
});
