import { describe, it, expect } from 'vitest';

import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import type { DescribedField, DescribedObject } from './DataQualityScanner.js';
import {
  detectPersonalData,
  erasureMethodOf,
  isFilledValue,
  planErasure,
  searchKindOf,
  subjectNameField,
  subjectSearchFields,
} from './personalDataFields.js';

/** A described field, writable and nillable unless told otherwise. */
function field(name: string, type: string, extra: Partial<DescribedField> = {}): DescribedField {
  return {
    name,
    label: name,
    type,
    createable: true,
    updateable: true,
    nillable: true,
    filterable: true,
    ...extra,
  };
}

/** A contact as the org describes one: its name composed, not written. */
const contact: DescribedObject = {
  name: 'Contact',
  label: 'Contact',
  queryable: true,
  updateable: true,
  deletable: true,
  fields: [
    field('Id', 'id', { updateable: false, createable: false }),
    field('Name', 'string', { nameField: true, updateable: false, createable: false }),
    field('FirstName', 'string'),
    field('LastName', 'string', { nillable: false }),
    field('Email', 'email'),
    field('Phone', 'phone'),
    field('AssistantPhone', 'phone'),
    field('HasOptedOutOfEmail', 'boolean', { label: 'Email Opt Out', nillable: false }),
    field('AccountId', 'reference', { referenceTo: ['Account'] }),
    field('Birthdate', 'date'),
    field('Notes__c', 'textarea', { filterable: false }),
    field('Email_Summary__c', 'string', { calculated: true, updateable: false }),
  ],
};

describe('personal data fields', () => {
  it('leaves a checkbox and a lookup out, whatever their names say', () => {
    const found = detectPersonalData(new PIIDetector(), 'Contact', contact.fields);

    const names = found.map((d) => d.field.name);
    expect(names).toContain('Email');
    expect(names).toContain('Birthdate');
    // The detector names HasOptedOutOfEmail from its label; a flag holds no address.
    expect(names).not.toContain('HasOptedOutOfEmail');
    expect(names).not.toContain('AccountId');
  });

  it('names a field from the values of the records it is given', () => {
    const found = detectPersonalData(new PIIDetector(), 'Contact', contact.fields, [
      { Id: '003000000000001AAA', Notes__c: 'wrote from someone@example.com' },
    ]);

    expect(found.find((d) => d.field.name === 'Notes__c')).toMatchObject({
      detectedBy: 'content',
      pattern: 'email_content',
    });
  });

  it('looks for an address in email fields and a number in phone fields, by their type', () => {
    expect(searchKindOf(field('Email', 'email'))).toBe('email');
    expect(searchKindOf(field('Fax', 'phone'))).toBe('phone');
    // The org will not filter on it, so it cannot be searched.
    expect(searchKindOf(field('Email', 'email', { filterable: false }))).toBeUndefined();
  });

  it('looks in a text field whose name ends like an email or a phone field, and in no other', () => {
    // A case keeps the number a web form sent as text.
    expect(searchKindOf(field('SuppliedPhone', 'string'))).toBe('phone');
    expect(searchKindOf(field('Personal_Email__c', 'string'))).toBe('email');
    // Mentions an email; holds a reason.
    expect(searchKindOf(field('EmailBouncedReason', 'string'))).toBeUndefined();
    expect(searchKindOf(field('Phone_Notes__c', 'textarea'))).toBeUndefined();
  });

  it('reads no value the org wrote itself for what it looks like', () => {
    const found = detectPersonalData(
      new PIIDetector(),
      'Contact',
      [field('PhotoUrl', 'url', { createable: false, updateable: false }), field('Email', 'email')],
      [{ Id: '003000000000001AAA', PhotoUrl: '/services/images/photo/003AB12CD34EF56GH' }],
    );

    expect(found.map((d) => d.field.name)).toEqual(['Email']);
  });

  it('erases what an address in the values gives away, not what only looks like a number', () => {
    const account: DescribedObject = {
      name: 'Account',
      label: 'Account',
      fields: [
        field('Name', 'string', { nameField: true, nillable: false }),
        field('Registration__c', 'string'),
        field('Comments__c', 'textarea', { filterable: false }),
      ],
    };
    const detected = detectPersonalData(new PIIDetector(), 'Account', account.fields, [
      { Id: '001000000000001AAA', Registration__c: '12345678901234', Comments__c: 'ask a@b.co' },
    ]);
    expect(detected.map((d) => d.pattern)).toEqual(
      expect.arrayContaining(['phone_content', 'email_content']),
    );

    const plan = planErasure(account, detected);

    expect(plan.fields.map((e) => e.field.name)).toEqual(['Comments__c', 'Name']);
  });

  it('looks for a name in the record name, but never in a number the org assigns', () => {
    expect(subjectNameField(contact)?.name).toBe('Name');
    const caseObject: DescribedObject = {
      name: 'Case',
      label: 'Case',
      fields: [field('CaseNumber', 'string', { nameField: true, autoNumber: true })],
    };
    expect(subjectNameField(caseObject)).toBeUndefined();
    expect(subjectSearchFields(contact).map((f) => `${f.field.name}:${f.kind}`)).toEqual([
      'Email:email',
      'Phone:phone',
      'AssistantPhone:phone',
      'Name:name',
    ]);
  });

  it('overwrites the name through its parts where the name itself cannot be written', () => {
    const plan = planErasure(
      contact,
      detectPersonalData(new PIIDetector(), 'Contact', contact.fields),
    );

    const erased = plan.fields.map((e) => e.field.name);
    expect(erased).toEqual(expect.arrayContaining(['FirstName', 'LastName', 'Email', 'Birthdate']));
    expect(erased).not.toContain('Name');
  });

  it('writes the name itself where it can be written, as on an account', () => {
    const account: DescribedObject = {
      name: 'Account',
      label: 'Account',
      fields: [
        field('Name', 'string', { nameField: true, nillable: false }),
        field('Phone', 'phone'),
      ],
    };

    const plan = planErasure(
      account,
      detectPersonalData(new PIIDetector(), 'Account', account.fields),
    );

    expect(plan.fields.map((e) => e.field.name)).toEqual(['Phone', 'Name']);
  });

  it('keeps a field the connected user may not write, and says it is kept', () => {
    const locked: DescribedObject = {
      ...contact,
      fields: contact.fields.map((f) => (f.name === 'Birthdate' ? { ...f, updateable: false } : f)),
    };

    const plan = planErasure(
      locked,
      detectPersonalData(new PIIDetector(), 'Contact', locked.fields),
    );

    expect(plan.kept.map((f) => f.name)).toEqual(['Birthdate']);
    expect(plan.fields.map((e) => e.field.name)).not.toContain('Birthdate');
  });

  it('leaves a formula alone: it follows the fields it is computed from', () => {
    const plan = planErasure(
      contact,
      detectPersonalData(new PIIDetector(), 'Contact', contact.fields, [
        { Id: '003000000000001AAA', Email_Summary__c: 'someone@example.com' },
      ]),
    );

    expect(plan.fields.map((e) => e.field.name)).not.toContain('Email_Summary__c');
    expect(plan.kept.map((f) => f.name)).not.toContain('Email_Summary__c');
  });

  it('makes up a value the anonymizer knows, and empties what may be empty', () => {
    expect(erasureMethodOf(field('Email', 'email'))).toBe('fake');
    expect(erasureMethodOf(field('LastName', 'string', { nillable: false }))).toBe('fake');
    expect(erasureMethodOf(field('AssistantPhone', 'phone'))).toBe('nullify');
    expect(erasureMethodOf(field('Birthdate', 'date'))).toBe('nullify');
    // Required, and nothing the anonymizer knows: its opaque token.
    expect(erasureMethodOf(field('Passport__c', 'string', { nillable: false }))).toBe('fake');
  });

  it('counts a blank value as empty', () => {
    expect(isFilledValue('  ')).toBe(false);
    expect(isFilledValue(null)).toBe(false);
    expect(isFilledValue('x')).toBe(true);
    expect(isFilledValue(0)).toBe(true);
  });
});
