import { describe, it, expect, vi } from 'vitest';
import {
  cleanNodeRecords,
  describeTargetFieldSets,
  intersect,
  targetFieldSetsOf,
  type CleanNodeRecordsInput,
} from './RecordCleaner.js';
import { IdRemapper } from '../IdRemapper.js';
import type { FieldInfo, ForgeExecutorDeps } from '../ForgeExecutor.js';

const FIELDS: FieldInfo[] = [
  { name: 'Id', queryable: true, createable: false, isReference: false },
  { name: 'Name', queryable: true, createable: true, isReference: false },
  {
    name: 'AccountId',
    queryable: true,
    createable: true,
    isReference: true,
    referenceTo: ['Account'],
  },
  {
    name: 'RecordTypeId',
    queryable: true,
    createable: true,
    isReference: true,
    referenceTo: ['RecordType'],
  },
];

function makeInput(overrides?: Partial<CleanNodeRecordsInput>): CleanNodeRecordsInput {
  return {
    objectApiName: 'Contact',
    records: [],
    fieldInfos: FIELDS,
    remapper: new IdRemapper(),
    referenceFallback: 'nullify',
    ownerMappings: {},
    excludedFields: new Set(),
    fieldRename: {},
    creatableFields: new Set(['Id', 'Name', 'AccountId', 'RecordTypeId']),
    picklistValuesByField: null,
    ...overrides,
  };
}

describe('cleanNodeRecords', () => {
  it('remaps lookup values through the IdRemapper', () => {
    const remapper = new IdRemapper();
    remapper.add('001OLD', '001NEW');
    const [out] = cleanNodeRecords(
      makeInput({ records: [{ Id: '003A', AccountId: '001OLD', Name: 'X' }], remapper }),
    );
    expect(out.cleaned.AccountId).toBe('001NEW');
  });

  it('nullifies orphan FKs and records them for pass 2 (nullify fallback)', () => {
    const [out] = cleanNodeRecords(
      makeInput({ records: [{ Id: '003A', AccountId: '001ORPHAN', Name: 'X' }] }),
    );
    expect('AccountId' in out.cleaned).toBe(false);
    expect(out.nullifiedFks).toEqual([
      { field: 'AccountId', sourceRefId: '001ORPHAN', targetObjects: ['Account'] },
    ]);
  });

  it('keeps orphan FK values under the keep fallback', () => {
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', AccountId: '001ORPHAN' }],
        referenceFallback: 'keep',
      }),
    );
    expect(out.cleaned.AccountId).toBe('001ORPHAN');
    expect(out.nullifiedFks).toEqual([]);
  });

  it('empties a lookup at an object that failed in the run under the keep fallback, and keeps the others', () => {
    // The run tried to write the account and could not: its source id names
    // nothing the run wrote. An id at an object that did not fail is carried
    // across as the keep fallback says, and so is an account the run wrote.
    const remapper = new IdRemapper();
    remapper.add('001WRITTEN', '001NEW');
    const fieldInfos: FieldInfo[] = [
      ...FIELDS,
      {
        name: 'Territory__c',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Territory__c'],
      },
    ];
    const [lost, written] = cleanNodeRecords(
      makeInput({
        records: [
          { Id: '003A', AccountId: '001FAILED', Territory__c: 'a0TKEPT' },
          { Id: '003B', AccountId: '001WRITTEN', Territory__c: 'a0TKEPT' },
        ],
        fieldInfos,
        remapper,
        referenceFallback: 'keep',
        failedObjects: new Set(['Account']),
        creatableFields: new Set(['Name', 'AccountId', 'Territory__c']),
      }),
    );

    expect(lost.cleaned).toEqual({ Territory__c: 'a0TKEPT' });
    expect(lost.nullifiedFks).toEqual([
      { field: 'AccountId', sourceRefId: '001FAILED', targetObjects: ['Account'] },
    ]);
    expect(written.cleaned).toEqual({ AccountId: '001NEW', Territory__c: 'a0TKEPT' });
    expect(written.nullifiedFks).toEqual([]);
  });

  it('empties a lookup at an object the run writes under the keep fallback, for the second pass to fill in', () => {
    // The account is written later in the run: its source id names, in the
    // target, nothing or a record other than the copy. Kept across are the
    // ids of what the run does not write, and a lookup that can name several
    // objects, whose id may be any of theirs.
    const fieldInfos: FieldInfo[] = [
      ...FIELDS,
      {
        name: 'Territory__c',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Territory__c'],
      },
      {
        name: 'WhatId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Account', 'Case'],
      },
    ];
    const [out] = cleanNodeRecords(
      makeInput({
        records: [
          { Id: '003A', AccountId: '001LATER', Territory__c: 'a0TKEPT', WhatId: '500KEPT' },
        ],
        fieldInfos,
        referenceFallback: 'keep',
        writtenObjects: new Set(['Account', 'Contact']),
        creatableFields: new Set(['Name', 'AccountId', 'Territory__c', 'WhatId']),
      }),
    );

    expect(out.cleaned).toEqual({ Territory__c: 'a0TKEPT', WhatId: '500KEPT' });
    expect(out.nullifiedFks).toEqual([
      { field: 'AccountId', sourceRefId: '001LATER', targetObjects: ['Account'] },
    ]);
  });

  it('never nullifies RecordTypeId and never remaps it through the generic remapper', () => {
    const remapper = new IdRemapper();
    remapper.add('012SOURCE', '012ACCIDENTAL');
    const [out] = cleanNodeRecords(
      makeInput({ records: [{ Id: '003A', RecordTypeId: '012SOURCE' }], remapper }),
    );
    expect(out.cleaned.RecordTypeId).toBe('012SOURCE');
    expect(out.nullifiedFks).toEqual([]);
  });

  it('applies owner mappings before insert', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'OwnerId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['User'],
      },
    ];
    const remapper = new IdRemapper();
    remapper.add('005EX_EMPLOYEE', '005REMAPPED');
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005EX_EMPLOYEE' }],
        fieldInfos: fields,
        remapper,
        ownerMappings: { '005REMAPPED': '005FINAL' },
        creatableFields: new Set(['Id', 'OwnerId']),
      }),
    );
    expect(out.cleaned.OwnerId).toBe('005FINAL');
  });

  it('sends one of two mutually exclusive fields, keeping the authoritative one', () => {
    const fields: FieldInfo[] = [
      { name: 'Quantity', queryable: true, createable: true, isReference: false },
      { name: 'UnitPrice', queryable: true, createable: true, isReference: false },
      { name: 'TotalPrice', queryable: true, createable: true, isReference: false },
    ];
    const [out] = cleanNodeRecords(
      makeInput({
        objectApiName: 'OpportunityLineItem',
        records: [{ Quantity: 2, UnitPrice: 7.85, TotalPrice: 15.7 }],
        fieldInfos: fields,
        creatableFields: new Set(['Quantity', 'UnitPrice', 'TotalPrice']),
      }),
    );
    // TotalPrice is UnitPrice x Quantity, so the unit price is the one that
    // reproduces the other.
    expect(out.cleaned).toEqual({ Quantity: 2, UnitPrice: 7.85 });
  });

  describe("an email's task", () => {
    const EMAIL_FIELDS: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Subject', queryable: true, createable: true, isReference: false },
      {
        name: 'ActivityId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Task'],
      },
      {
        name: 'ParentId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Case'],
      },
      {
        name: 'RelatedToId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Quote', 'Opportunity', 'Case'],
      },
    ];
    const emailInput = (
      records: Record<string, unknown>[],
      remapper: IdRemapper,
    ): CleanNodeRecordsInput =>
      makeInput({
        objectApiName: 'EmailMessage',
        records,
        fieldInfos: EMAIL_FIELDS,
        remapper,
        creatableFields: new Set(['Subject', 'ActivityId', 'ParentId', 'RelatedToId']),
      });

    it('is never sent with an email that is not on a case, nor left for the second pass', () => {
      // Run for real, the one email of an opportunity went with the task it
      // names and the target refused it: "you cannot modify this field".
      const remapper = new IdRemapper();
      remapper.add('00TWRITTEN', '00TNEW');
      remapper.add('0Q0QUOTE', '0Q0NEW');
      const [written, waiting] = cleanNodeRecords(
        emailInput(
          [
            { Id: '02sA', Subject: 'Offer', ActivityId: '00TWRITTEN', RelatedToId: '0Q0QUOTE' },
            { Id: '02sB', Subject: 'Offer', ActivityId: '00TLATER', RelatedToId: '0Q0QUOTE' },
          ],
          remapper,
        ),
      );

      expect(written.cleaned).toEqual({ Subject: 'Offer', RelatedToId: '0Q0NEW' });
      expect(waiting.cleaned).toEqual({ Subject: 'Offer', RelatedToId: '0Q0NEW' });
      expect(waiting.nullifiedFks).toEqual([]);
    });

    it('goes with an email on a case, which may name it', () => {
      const remapper = new IdRemapper();
      remapper.add('00TWRITTEN', '00TNEW');
      remapper.add('500CASE', '500NEW');
      const [out] = cleanNodeRecords(
        emailInput(
          [{ Id: '02sA', Subject: 'Reply', ActivityId: '00TWRITTEN', ParentId: '500CASE' }],
          remapper,
        ),
      );

      expect(out.cleaned).toEqual({ Subject: 'Reply', ActivityId: '00TNEW', ParentId: '500NEW' });
    });

    it('goes with an email related to a case through RelatedToId alone, which is on it', () => {
      // Told by ParentId alone, the email went without its task, though the
      // platform takes the task of an email whose RelatedToId is a case.
      const remapper = new IdRemapper();
      remapper.add('00TWRITTEN', '00TNEW');
      remapper.add('500CASE', '500NEW');
      const [out] = cleanNodeRecords(
        emailInput(
          [{ Id: '02sA', Subject: 'Reply', ActivityId: '00TWRITTEN', RelatedToId: '500CASE' }],
          remapper,
        ),
      );

      expect(out.cleaned).toEqual({
        Subject: 'Reply',
        ActivityId: '00TNEW',
        RelatedToId: '500NEW',
      });
      expect(out.nullifiedFks).toEqual([]);
    });
  });

  it('keeps a lone total price when no unit price travels with it', () => {
    const fields: FieldInfo[] = [
      { name: 'TotalPrice', queryable: true, createable: true, isReference: false },
    ];
    const [out] = cleanNodeRecords(
      makeInput({
        objectApiName: 'OpportunityLineItem',
        records: [{ TotalPrice: 15.7 }],
        fieldInfos: fields,
        creatableFields: new Set(['TotalPrice']),
      }),
    );
    expect(out.cleaned).toEqual({ TotalPrice: 15.7 });
  });

  it('applies an owner mapping whose User was never cloned', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'OwnerId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['User'],
      },
    ];
    // No remapper entry: the case the flag exists for. A User is never
    // cloned, so its source ID is never in the remapper, and the mapping
    // has nothing but the source value to key on.
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005SOURCE' }],
        fieldInfos: fields,
        ownerMappings: { '005SOURCE': '005TARGET' },
        creatableFields: new Set(['Id', 'OwnerId']),
      }),
    );
    expect(out.cleaned.OwnerId).toBe('005TARGET');
  });

  it('does not queue a lookup at an uncopyable object for pass 2', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'OwnerId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['User'],
      },
      {
        name: 'AccountId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Account'],
      },
    ];
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005SOURCE', AccountId: '001ORPHAN' }],
        fieldInfos: fields,
        creatableFields: new Set(['OwnerId', 'AccountId']),
      }),
    );
    // Account can be cloned by a later wave, so its orphan FK is a real
    // debt. No wave will ever produce a User, so pass 2 must not be told
    // to wait for one.
    expect(out.nullifiedFks.map((f) => f.field)).toEqual(['AccountId']);
    expect(out.cleaned.OwnerId).toBeUndefined();
  });

  it('does not queue a lookup at an object every copy leaves out', () => {
    // Run for real: `LastAmountChangedHistoryId` waited for an
    // `OpportunityHistory` no wave writes, and was reported unresolved.
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'LastAmountChangedHistoryId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['OpportunityHistory'],
      },
    ];
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '006A', LastAmountChangedHistoryId: '008SOURCE' }],
        fieldInfos: fields,
        creatableFields: new Set(['LastAmountChangedHistoryId']),
      }),
    );
    expect(out.nullifiedFks).toEqual([]);
  });

  it('never owes the second pass a lookup no write can set', () => {
    // A person account's contact, read with the account: the platform writes
    // it with the account and fills the lookup, and refuses an update of it.
    // A lookup an update can set is owed as before.
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'PersonContactId',
        queryable: true,
        createable: false,
        updateable: false,
        isReference: true,
        referenceTo: ['Contact'],
        nillable: true,
      },
      {
        name: 'Key_Contact__c',
        queryable: true,
        createable: false,
        updateable: true,
        isReference: true,
        referenceTo: ['Contact'],
        nillable: true,
      },
    ];
    const [out] = cleanNodeRecords(
      makeInput({
        objectApiName: 'Account',
        records: [{ Id: '001A', PersonContactId: '003SOURCE', Key_Contact__c: '003SOURCE' }],
        fieldInfos: fields,
        creatableFields: new Set(),
        writtenObjects: new Set(['Account', 'Contact']),
      }),
    );

    expect(out.nullifiedFks).toEqual([
      { field: 'Key_Contact__c', sourceRefId: '003SOURCE', targetObjects: ['Contact'] },
    ]);
    expect(out.cleaned).toEqual({});
  });

  describe("what the second pass is owed, read from the target's describe", () => {
    /** A lookup the user the run reads as may not set: read-only to it in the source. */
    const readOnlyInTheSource: FieldInfo = {
      name: 'Reviewer__c',
      queryable: true,
      createable: false,
      updateable: false,
      isReference: true,
      referenceTo: ['Contact'],
      nillable: true,
    };

    it('owes it a lookup the source user may not set and the target user may', () => {
      // Read from the source's describe alone, no write could set it, and the
      // second pass never filled it in, though the target let it.
      const [out] = cleanNodeRecords(
        makeInput({
          records: [{ Id: '003A', Reviewer__c: '003SOURCE' }],
          fieldInfos: [readOnlyInTheSource],
          creatableFields: new Set(),
          updatableFields: new Set(['Reviewer__c']),
          writtenObjects: new Set(['Contact']),
        }),
      );

      expect(out.nullifiedFks).toEqual([
        { field: 'Reviewer__c', sourceRefId: '003SOURCE', targetObjects: ['Contact'] },
      ]);
      expect(out.cleaned).toEqual({});
    });

    it('owes it such a lookup at a record the run has written already, which the insert could not carry', () => {
      const remapper = new IdRemapper();
      remapper.add('003SOURCE', '003TARGET');
      const [out] = cleanNodeRecords(
        makeInput({
          records: [{ Id: '003A', Reviewer__c: '003SOURCE' }],
          fieldInfos: [readOnlyInTheSource],
          creatableFields: new Set(),
          updatableFields: new Set(['Reviewer__c']),
          remapper,
        }),
      );

      expect(out.nullifiedFks).toEqual([
        { field: 'Reviewer__c', sourceRefId: '003SOURCE', targetObjects: ['Contact'] },
      ]);
    });

    it('owes it nothing of a lookup the target user may not set either', () => {
      // Owed, it went in an update the target refused, which took the row's
      // other lookups of that update down with it.
      const [out] = cleanNodeRecords(
        makeInput({
          records: [{ Id: '003A', AccountId: '001ORPHAN' }],
          creatableFields: new Set(['Name']),
          updatableFields: new Set(['Name']),
        }),
      );

      expect(out.nullifiedFks).toEqual([]);
      expect(out.cleaned).toEqual({});
    });

    it('marks a lookup only an insert sets, whose record is not written yet, for the second pass to say it is left empty', () => {
      // An email's case: createable, not updateable. The second pass cannot
      // fill it in, and sent, its update was refused.
      const [out] = cleanNodeRecords(
        makeInput({
          records: [{ Id: '003A', AccountId: '001LATER' }],
          creatableFields: new Set(['AccountId']),
          updatableFields: new Set(),
        }),
      );

      expect(out.nullifiedFks).toEqual([
        {
          field: 'AccountId',
          sourceRefId: '001LATER',
          targetObjects: ['Account'],
          insertOnly: true,
        },
      ]);
    });

    it("reads it from the source's describe when the target's could not be read", () => {
      const fields: FieldInfo[] = [
        { ...readOnlyInTheSource, name: 'Case__c', createable: true, referenceTo: ['Case'] },
        { ...readOnlyInTheSource, name: 'Owner__c', referenceTo: ['Contact'] },
      ];
      const [out] = cleanNodeRecords(
        makeInput({
          records: [{ Id: '003A', Case__c: '500LATER', Owner__c: '003LATER' }],
          fieldInfos: fields,
          creatableFields: new Set(['Case__c']),
        }),
      );

      expect(out.nullifiedFks).toEqual([
        { field: 'Case__c', sourceRefId: '500LATER', targetObjects: ['Case'], insertOnly: true },
      ]);
    });
  });

  it('strips non-createable fields, exclusions and null values', () => {
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', Name: null, AccountId: '001ORPHAN' }],
        excludedFields: new Set(['Name']),
        creatableFields: new Set(['Name', 'AccountId']),
      }),
    );
    // Id not createable, Name excluded, AccountId nullified → null → omitted.
    expect(out.cleaned).toEqual({});
  });

  it('writes renamed fields under the target API name, bypassing the source createable check', () => {
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', Region__c: 'EMEA' }],
        fieldRename: { Region__c: 'Region__pc' },
        creatableFields: new Set(['Region__c']),
      }),
    );
    expect(out.cleaned).toEqual({ Region__pc: 'EMEA' });
  });

  it('treats IsPersonAccount 1 as a person account and null as a business account', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Name', queryable: true, createable: true, isReference: false },
      { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
      { name: 'Custom__pc', queryable: true, createable: true, isReference: false },
    ];
    const creatableFields = new Set(['Name', 'Custom__pc']);

    const [person] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '001C', Name: 'Jane Roe', IsPersonAccount: 1, Custom__pc: 'y' }],
        fieldInfos: fields,
        creatableFields,
      }),
    );
    expect(person.cleaned).toEqual({ Custom__pc: 'y' });

    const [business] = cleanNodeRecords(
      makeInput({
        // An org without Person Accounts enabled returns no value at all.
        records: [{ Id: '001D', Name: 'Globex', IsPersonAccount: null, Custom__pc: 'y' }],
        fieldInfos: fields,
        creatableFields,
      }),
    );
    expect(business.cleaned).toEqual({ Name: 'Globex' });
  });

  it('strips __pc fields from business accounts but keeps them on person accounts (string coercion)', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Name', queryable: true, createable: true, isReference: false },
      { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
      { name: 'PersonEmail', queryable: true, createable: true, isReference: false },
      { name: 'Custom__pc', queryable: true, createable: true, isReference: false },
    ];
    const creatableFields = new Set(['Name', 'PersonEmail', 'Custom__pc']);
    const [business] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '001A', Name: 'Acme', IsPersonAccount: false, Custom__pc: 'x' }],
        fieldInfos: fields,
        creatableFields,
      }),
    );
    expect(business.cleaned).toEqual({ Name: 'Acme' });

    const [person] = cleanNodeRecords(
      makeInput({
        // jsforce SOAP-normalized string 'true' must still count as person account.
        records: [{ Id: '001B', Name: 'John Doe', IsPersonAccount: 'true', Custom__pc: 'x' }],
        fieldInfos: fields,
        creatableFields,
      }),
    );
    // Name is auto-computed on person accounts → dropped; __pc kept.
    expect(person.cleaned).toEqual({ Custom__pc: 'x' });
  });

  it('keeps the name of a person account a target without person accounts takes as a business one', () => {
    // The target computes no name there, and refused the account without one.
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Name', queryable: true, createable: true, isReference: false },
      { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
    ];
    const [person] = cleanNodeRecords(
      makeInput({
        objectApiName: 'Account',
        records: [{ Id: '001B', Name: 'John Doe', IsPersonAccount: true }],
        fieldInfos: fields,
        creatableFields: new Set(['Name']),
        personAccountsInTarget: false,
      }),
    );

    expect(person.cleaned).toEqual({ Name: 'John Doe' });
  });

  it('drops picklist values the target org does not accept', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Status', queryable: true, createable: true, isReference: false },
    ];
    const picklistValuesByField = new Map([['Status', new Set(['Open', 'Closed'])]]);
    const [kept, dropped] = cleanNodeRecords(
      makeInput({
        records: [
          { Id: '003A', Status: 'Open' },
          { Id: '003B', Status: 'SourceOnlyValue' },
        ],
        fieldInfos: fields,
        creatableFields: new Set(['Status']),
        picklistValuesByField,
      }),
    );
    expect(kept.cleaned.Status).toBe('Open');
    expect('Status' in dropped.cleaned).toBe(false);
  });

  describe('picklist values and the record type a row goes in with', () => {
    const SOURCE_RETAIL = '012000000000001AAA';
    const SOURCE_TRADE = '012000000000002AAA';
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Status__c', queryable: true, createable: true, isReference: false },
      {
        name: 'RecordTypeId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['RecordType'],
      },
    ];
    const restricted = new Map([
      ['Status__c', { multi: false, restricted: true, required: false }],
    ]);
    const retail = {
      recordType: 'Retail',
      picklists: new Map([['Status__c', { values: ['New', 'Open'], defaultValue: 'New' }]]),
    };

    it('checks a row against the record type it was read with, and says what it changed', () => {
      const [ofRetail, ofTrade, untyped] = cleanNodeRecords(
        makeInput({
          records: [
            { Id: 'a01A', Status__c: 'Old', RecordTypeId: SOURCE_RETAIL },
            { Id: 'a01B', Status__c: 'Old', RecordTypeId: SOURCE_TRADE },
            { Id: 'a01C', Status__c: 'Old' },
          ],
          fieldInfos: fields,
          creatableFields: new Set(['Status__c', 'RecordTypeId']),
          picklistValuesByField: new Map([['Status__c', new Set(['New', 'Open', 'Old'])]]),
          picklistFields: restricted,
          recordTypeValues: new Map([[SOURCE_RETAIL, retail]]),
        }),
      );

      // Still the source's record type: the record type mapping translates it after.
      expect(ofRetail.cleaned).toEqual({ Status__c: 'New', RecordTypeId: SOURCE_RETAIL });
      expect(ofRetail.picklistChanges).toEqual([
        {
          field: 'Status__c',
          reason: 'record-type',
          values: ['Old'],
          recordType: 'Retail',
          replacedBy: 'New',
          replacement: 'default',
        },
      ]);
      // A record type that was not read, and none: the values of the field, as before.
      expect(ofTrade.cleaned).toEqual({ Status__c: 'Old', RecordTypeId: SOURCE_TRADE });
      expect(untyped.cleaned).toEqual({ Status__c: 'Old' });
      expect(ofTrade.picklistChanges).toEqual([]);
      expect(untyped.picklistChanges).toEqual([]);
    });

    it('says a value it left out for want of a place among the values of the field', () => {
      const [out] = cleanNodeRecords(
        makeInput({
          records: [{ Id: 'a01A', Status__c: 'Gone' }],
          fieldInfos: fields,
          creatableFields: new Set(['Status__c']),
          picklistValuesByField: new Map([['Status__c', new Set(['New'])]]),
        }),
      );

      expect(out.cleaned).toEqual({});
      expect(out.picklistChanges).toEqual([
        { field: 'Status__c', reason: 'not-in-target', values: ['Gone'] },
      ]);
    });

    it('keeps a selection of values the target holds, one value at a time', () => {
      // Looked up whole, `Red;Blue` is no value of the field, and every
      // selection of more than one value was dropped.
      const [out] = cleanNodeRecords(
        makeInput({
          records: [{ Id: 'a01A', Colors__c: 'Red;Blue' }],
          fieldInfos: [
            { name: 'Colors__c', queryable: true, createable: true, isReference: false },
          ],
          creatableFields: new Set(['Colors__c']),
          picklistValuesByField: new Map([['Colors__c', new Set(['Red', 'Blue'])]]),
          picklistFields: new Map([
            ['Colors__c', { multi: true, restricted: false, required: false }],
          ]),
        }),
      );

      expect(out.cleaned).toEqual({ Colors__c: 'Red;Blue' });
    });

    it('leaves a value written under a rename to the field map', () => {
      const [out] = cleanNodeRecords(
        makeInput({
          records: [{ Id: 'a01A', Legacy__c: 'Gone', RecordTypeId: SOURCE_RETAIL }],
          fieldInfos: fields,
          creatableFields: new Set(['Status__c', 'RecordTypeId']),
          fieldRename: { Legacy__c: 'Status__c' },
          picklistValuesByField: new Map([['Status__c', new Set(['New'])]]),
          picklistFields: restricted,
          recordTypeValues: new Map([[SOURCE_RETAIL, retail]]),
        }),
      );

      expect(out.cleaned).toEqual({ Status__c: 'Gone', RecordTypeId: SOURCE_RETAIL });
      expect(out.picklistChanges).toEqual([]);
    });
  });
});

describe('describeTargetFieldSets', () => {
  it('returns the createable set and picklist whitelists', async () => {
    const describeFields = vi.fn<ForgeExecutorDeps['describeFields']>().mockResolvedValue([
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'Status',
        queryable: true,
        createable: true,
        isReference: false,
        picklistValues: ['Open'],
      },
    ]);
    const sets = await describeTargetFieldSets(describeFields, 'tgt', 'Case');
    expect(describeFields).toHaveBeenCalledWith('tgt', 'Case');
    expect(sets.creatable).toEqual(new Set(['Status']));
    expect(sets.picklistValuesByField?.get('Status')).toEqual(new Set(['Open']));
  });

  it('says which fields an update can set in the target, an unsaid flag reading as one it can', () => {
    const sets = targetFieldSetsOf([
      { name: 'ParentId', queryable: true, createable: true, isReference: true, updateable: false },
      { name: 'ContactId', queryable: true, createable: true, isReference: true, updateable: true },
      { name: 'Subject', queryable: true, createable: true, isReference: false },
    ]);

    expect(sets.updateable).toEqual(new Set(['ContactId', 'Subject']));
    expect(sets.creatable).toEqual(new Set(['ParentId', 'ContactId', 'Subject']));
  });

  it('says which picklist fields of the target are restricted, required and dependent', async () => {
    const describeFields = vi.fn<ForgeExecutorDeps['describeFields']>().mockResolvedValue([
      { name: 'Name', queryable: true, createable: true, isReference: false, type: 'string' },
      {
        name: 'Status__c',
        queryable: true,
        createable: true,
        isReference: false,
        type: 'picklist',
        picklistValues: ['Open', 'Closed'],
        restrictedPicklist: true,
        nillable: false,
      },
      {
        name: 'Reason__c',
        queryable: true,
        createable: true,
        isReference: false,
        type: 'picklist',
        picklistValues: ['Late'],
        restrictedPicklist: true,
        controllerName: 'Status__c',
      },
    ]);

    const sets = await describeTargetFieldSets(describeFields, 'tgt', 'Order__c');

    expect(Object.fromEntries(sets.picklistFields)).toEqual({
      Status__c: { multi: false, restricted: true, required: true },
      Reason__c: { multi: false, restricted: true, required: false, controllerName: 'Status__c' },
    });
  });

  it('returns a null picklist map when no restricted picklist exists', async () => {
    const describeFields = vi
      .fn<ForgeExecutorDeps['describeFields']>()
      .mockResolvedValue([{ name: 'Name', queryable: true, createable: true, isReference: false }]);
    const sets = await describeTargetFieldSets(describeFields, 'tgt', 'Account');
    expect(sets.picklistValuesByField).toBeNull();
  });

  it('propagates describe failures so the caller can fall back to source schema', async () => {
    const describeFields = vi
      .fn<ForgeExecutorDeps['describeFields']>()
      .mockRejectedValue(new Error('auth expired'));
    await expect(describeTargetFieldSets(describeFields, 'tgt', 'Account')).rejects.toThrow(
      'auth expired',
    );
  });
});

describe('intersect', () => {
  it('keeps only values present in both sets', () => {
    expect(intersect(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toEqual(
      new Set(['b', 'c']),
    );
  });
});

describe('lookups at objects no clone creates', () => {
  const ownerField: FieldInfo[] = [
    { name: 'Id', queryable: true, createable: false, isReference: false },
    {
      name: 'OwnerId',
      queryable: true,
      createable: true,
      isReference: true,
      referenceTo: ['User'],
    },
  ];

  it('drops OwnerId so the platform fills it in', () => {
    // A source-org User id written into a target org points at nobody. On a
    // real UAT → DEV run this is what made the second pass report "cycle FK
    // could not be resolved" and lose the record. Dropped, Salesforce sets the
    // owner to the running user — which is what seeding a sandbox wants.
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005SOURCEONLY' }],
        fieldInfos: ownerField,
        referenceFallback: 'nullify',
        creatableFields: new Set(['OwnerId']),
      }),
    );

    expect('OwnerId' in out.cleaned).toBe(false);
  });

  it('keeps it when the caller asked to carry ids across as they are', () => {
    // `keep` answers a different question — an FK whose target was in the
    // graph and was not cloned — and is meaningful when both orgs are one.
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005SOURCEONLY' }],
        fieldInfos: ownerField,
        referenceFallback: 'keep',
        creatableFields: new Set(['OwnerId']),
      }),
    );

    expect(out.cleaned.OwnerId).toBe('005SOURCEONLY');
  });

  it('leaves a lookup at an object a clone can create alone', () => {
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', AccountId: '001SOURCE' }],
        fieldInfos: [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          {
            name: 'AccountId',
            queryable: true,
            createable: true,
            isReference: true,
            referenceTo: ['Account'],
          },
        ],
        referenceFallback: 'keep',
        creatableFields: new Set(['AccountId']),
      }),
    );

    expect(out.cleaned.AccountId).toBe('001SOURCE');
  });
});
