import { describe, it, expect } from 'vitest';
import type { DataOpsAnonymizationRule } from '@sandforge/shared';

import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { ANONYMIZATION_TEMPLATES } from '../../bridge/templates/anonymizationTemplates.js';
import {
  personAccountFieldOf,
  personAccountMasking,
  personAccountRules,
  rulesOfRow,
  type MaskableField,
} from './personAccountMasking.js';

/** A template that ships, by id. */
function shipped(id: string) {
  const template = ANONYMIZATION_TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`no template ${id}`);
  return template;
}

/** A rule as the masking engine takes it. */
function rule(fieldApiName: string, method: DataOpsAnonymizationRule['method'] = 'fake') {
  return { objectApiName: 'Account', fieldApiName, method, config: {} };
}

/**
 * The account of an org with person accounts, cut down to what a masking run
 * reads, with the labels the platform gives its fields.
 */
const PERSON_ACCOUNT_ORG: MaskableField[] = [
  { name: 'Id', label: 'Account ID', type: 'id', updateable: false },
  { name: 'IsPersonAccount', label: 'Is Person Account', type: 'boolean', updateable: false },
  { name: 'Name', label: 'Account Name', type: 'string', updateable: true, nillable: false },
  { name: 'Phone', label: 'Account Phone', type: 'phone', updateable: true, nillable: true },
  { name: 'Fax', label: 'Account Fax', type: 'phone', updateable: true, nillable: true },
  {
    name: 'BillingStreet',
    label: 'Billing Street',
    type: 'textarea',
    updateable: true,
    nillable: true,
  },
  { name: 'FirstName', label: 'First Name', type: 'string', updateable: true, nillable: true },
  { name: 'LastName', label: 'Last Name', type: 'string', updateable: true, nillable: true },
  { name: 'Salutation', label: 'Salutation', type: 'picklist', updateable: true, nillable: true },
  { name: 'PersonEmail', label: 'Email', type: 'email', updateable: true, nillable: true },
  { name: 'PersonMobilePhone', label: 'Mobile', type: 'phone', updateable: true, nillable: true },
  {
    name: 'PersonHomePhone',
    label: 'Home Phone',
    type: 'phone',
    updateable: true,
    nillable: true,
  },
  { name: 'PersonBirthdate', label: 'Birthdate', type: 'date', updateable: true, nillable: true },
  {
    name: 'PersonMailingStreet',
    label: 'Mailing Street',
    type: 'textarea',
    updateable: true,
    nillable: true,
  },
  {
    name: 'PersonMailingCity',
    label: 'Mailing City',
    type: 'string',
    updateable: true,
    nillable: true,
  },
  {
    name: 'PersonMailingPostalCode',
    label: 'Mailing Zip/Postal Code',
    type: 'string',
    updateable: true,
    nillable: true,
  },
  {
    name: 'PersonContactId',
    label: 'Person Contact ID',
    type: 'reference',
    updateable: false,
    nillable: true,
  },
];

describe('personAccountFieldOf', () => {
  it.each([
    ['FirstName', 'FirstName'],
    ['LastName', 'LastName'],
    ['Phone', 'Phone'],
    ['Email', 'PersonEmail'],
    ['MobilePhone', 'PersonMobilePhone'],
    ['MailingPostalCode', 'PersonMailingPostalCode'],
    ['Birthdate', 'PersonBirthdate'],
    ['Loyalty_Tier__c', 'Loyalty_Tier__pc'],
  ])("finds a contact's %s on a person account as %s", (contactField, accountField) => {
    expect(personAccountFieldOf(contactField)).toBe(accountField);
  });

  it('finds nothing for a wildcard', () => {
    expect(personAccountFieldOf('*')).toBeUndefined();
  });
});

describe('personAccountRules', () => {
  it("applies the GDPR template's contact rules to the fields of a person account, with their settings", () => {
    const derived = personAccountRules(shipped('tpl-gdpr-standard').rules);

    expect(derived.map((r) => r.fieldPattern)).toEqual([
      'Account.FirstName',
      'Account.LastName',
      'Account.PersonEmail',
      'Account.PersonMailingStreet',
      'Account.PersonMailingCity',
      'Account.PersonMailingPostalCode',
    ]);
    // The phone the template masks on every account keeps the account's rule.
    expect(derived.some((r) => r.fieldPattern === 'Account.Phone')).toBe(false);
    expect(derived[2]).toMatchObject({ ruleType: 'fake' });
  });

  it("carries a contact rule's settings to the person account's field", () => {
    const derived = personAccountRules(shipped('tpl-hipaa-health').rules);

    expect(derived.find((r) => r.fieldPattern === 'Account.PersonMailingPostalCode')).toEqual({
      fieldPattern: 'Account.PersonMailingPostalCode',
      ruleType: 'truncate',
      description: 'Truncate to first 3 digits.',
      config: { truncateLength: 3, truncateKeep: 'first' },
    });
    expect(derived.find((r) => r.fieldPattern === 'Account.PersonBirthdate')).toMatchObject({
      ruleType: 'nullify',
    });
  });

  it('derives nothing from a template without contact rules', () => {
    expect(
      personAccountRules([
        { fieldPattern: 'Lead.Email', ruleType: 'hash', description: '' },
        { fieldPattern: 'Account.Name', ruleType: 'fake', description: '' },
      ]),
    ).toEqual([]);
  });
});

describe('personAccountMasking', () => {
  const detector = new PIIDetector();

  it('masks nothing apart on an object other than Account, or in an org without person accounts', () => {
    const derived = [rule('PersonEmail')];
    expect(
      personAccountMasking({
        objectApiName: 'Contact',
        fields: PERSON_ACCOUNT_ORG,
        kept: [],
        derived,
        detector,
      }),
    ).toBeUndefined();
    expect(
      personAccountMasking({
        objectApiName: 'Account',
        fields: PERSON_ACCOUNT_ORG.filter((f) => f.name !== 'IsPersonAccount'),
        kept: [],
        derived,
        detector,
      }),
    ).toBeUndefined();
  });

  it('keeps the derived rules on the fields the account has, and adds the person fields the detector names that no rule covers', () => {
    const masking = personAccountMasking({
      objectApiName: 'Account',
      fields: PERSON_ACCOUNT_ORG,
      kept: [rule('BillingStreet'), rule('Phone', 'mask')],
      derived: [rule('FirstName'), rule('LastName'), rule('PersonEmail'), rule('PersonNowhere')],
      detector,
    });

    const byField = new Map(masking?.rules.map((r) => [r.fieldApiName, r.method]));
    expect(byField.get('FirstName')).toBe('fake');
    expect(byField.get('PersonEmail')).toBe('fake');
    // A field the org lacks is not masked, nor said to be missing.
    expect(byField.has('PersonNowhere')).toBe(false);
    // What the template did not name, the detector does: a person's phones,
    // birthdate and salutation, overwritten as an erasure overwrites them.
    expect(byField.get('PersonMobilePhone')).toBe('fake');
    expect(byField.get('PersonHomePhone')).toBe('fake');
    expect(byField.get('PersonBirthdate')).toBe('nullify');
    expect(byField.get('Salutation')).toBe('nullify');
    // The account's own fields keep the template's rules, and a field no
    // update sets is not masked.
    expect(byField.has('Phone')).toBe(false);
    expect(byField.has('Fax')).toBe(false);
    expect(byField.has('PersonContactId')).toBe(false);
    expect([...(masking?.personOnly ?? [])]).toEqual(masking?.rules.map((r) => r.fieldApiName));
  });
});

describe('rulesOfRow', () => {
  const rules = [rule('Name'), rule('Phone', 'mask'), rule('FirstName'), rule('PersonEmail')];
  const personOnly = new Set(['FirstName', 'PersonEmail', 'Phone']);

  it("masks a business account by the account's own rules alone", () => {
    expect(
      rulesOfRow('Account', { Id: 'acc', IsPersonAccount: false }, rules, personOnly).map(
        (r) => r.fieldApiName,
      ),
    ).toEqual(['Name']);
  });

  it('masks a person account by every rule but the name the platform computes', () => {
    expect(
      rulesOfRow('Account', { Id: 'acc', IsPersonAccount: true }, rules, personOnly).map(
        (r) => r.fieldApiName,
      ),
    ).toEqual(['Phone', 'FirstName', 'PersonEmail']);
  });

  it('masks a row of any other object by every rule', () => {
    expect(rulesOfRow('Contact', { Id: 'con' }, rules, personOnly)).toEqual(rules);
  });
});
