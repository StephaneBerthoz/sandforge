import { describe, expect, it } from 'vitest';
import type { SeedRecordTypeOption } from '@sandforge/shared';

import {
  fieldsForAccountKind,
  offersRecordTypes,
  recordTypeFieldRule,
  recordTypesMixed,
  recordTypesPerson,
} from './seedRecordTypeChoices';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

const PERSON: SeedRecordTypeOption = {
  recordTypeId: '012000000000001AAA',
  developerName: 'PersonAccount',
  label: 'Person Account',
  person: true,
  isDefault: false,
};
const CUSTOMER: SeedRecordTypeOption = {
  recordTypeId: '012000000000002AAA',
  developerName: 'Customer',
  label: 'Customer',
  person: false,
  isDefault: true,
};
const PARTNER: SeedRecordTypeOption = {
  ...CUSTOMER,
  recordTypeId: '012000000000003AAA',
  developerName: 'Partner',
  label: 'Partner',
  isDefault: false,
};

describe('record type choices', () => {
  it('calls a person type and a business type chosen together a mix, and nothing else', () => {
    const options = [PERSON, CUSTOMER, PARTNER];
    expect(recordTypesMixed(options, [PERSON.recordTypeId, CUSTOMER.recordTypeId])).toBe(true);
    expect(recordTypesMixed(options, [CUSTOMER.recordTypeId, PARTNER.recordTypeId])).toBe(false);
    expect(recordTypesMixed(options, [PERSON.recordTypeId])).toBe(false);
    expect(recordTypesMixed(options, [])).toBe(false);
  });

  it('says the accounts are person accounts only when every type chosen is a person account’s', () => {
    expect(recordTypesPerson([PERSON, CUSTOMER], [PERSON.recordTypeId])).toBe(true);
    expect(recordTypesPerson([PERSON, CUSTOMER], [])).toBe(false);
    expect(recordTypesPerson([PERSON, CUSTOMER], [CUSTOMER.recordTypeId])).toBe(false);
  });

  it('offers a choice with two types or more, or a person account’s alone', () => {
    expect(offersRecordTypes([CUSTOMER, PARTNER])).toBe(true);
    expect(offersRecordTypes([PERSON])).toBe(true);
    expect(offersRecordTypes([CUSTOMER])).toBe(false);
    expect(offersRecordTypes(undefined)).toBe(false);
  });

  it('gives one type to every record, and several in turns at random, as the command line does', () => {
    expect(recordTypeFieldRule([PERSON.recordTypeId])).toEqual({
      fieldApiName: 'RecordTypeId',
      fieldType: 'reference',
      ruleType: 'static',
      config: { staticValue: PERSON.recordTypeId },
    });
    expect(recordTypeFieldRule([CUSTOMER.recordTypeId, PARTNER.recordTypeId])).toEqual({
      fieldApiName: 'RecordTypeId',
      fieldType: 'reference',
      ruleType: 'picklist_random',
      config: { picklistValues: [CUSTOMER.recordTypeId, PARTNER.recordTypeId] },
    });
  });
});

describe("an object's fields for the kind of account chosen", () => {
  const config = (objectApiName: string): ObjectFieldConfig => ({
    objectApiName,
    objectLabel: objectApiName,
    fields: ['Name', 'Phone', 'LastName', 'PersonEmail'].map((fieldApiName) => ({
      fieldApiName,
      label: fieldApiName,
      type: 'string',
      required: false,
      ruleType: 'faker',
      config: {},
    })),
    recordTypes: [PERSON, CUSTOMER],
  });
  const names = (c: ObjectFieldConfig) =>
    c.fields.map((f) => `${f.fieldApiName}${f.required ? '*' : ''}`);

  it('follows the rule the extension writes accounts by: no Name on a person account, its last name required', () => {
    expect(names(fieldsForAccountKind(config('Account'), [PERSON.recordTypeId]))).toEqual([
      'Phone',
      'LastName*',
      'PersonEmail',
    ]);
    expect(names(fieldsForAccountKind(config('Account'), [CUSTOMER.recordTypeId]))).toEqual([
      'Name*',
      'Phone',
    ]);
  });

  it('leaves every field to a mix, to a type it does not know, and to any other object', () => {
    const all = ['Name', 'Phone', 'LastName', 'PersonEmail'];
    expect(
      names(fieldsForAccountKind(config('Account'), [PERSON.recordTypeId, CUSTOMER.recordTypeId])),
    ).toEqual(all);
    expect(names(fieldsForAccountKind(config('Account'), ['012000000000009AAA']))).toEqual(all);
    expect(names(fieldsForAccountKind(config('Contact'), []))).toEqual(all);
  });
});
