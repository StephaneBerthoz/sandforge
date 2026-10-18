import { describe, expect, it, vi } from 'vitest';
import type { SeedTemplate } from '@sandforge/shared';

import {
  personRecordTypes,
  seedRecordTypeOptions,
  templateForAccountKinds,
} from './seedRecordTypes';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const PERSON_TYPE = fakeId('012', 1);
const BUSINESS_TYPE = fakeId('012', 2);

/** Account's record types as a describe gives them, the master's among them. */
const ACCOUNT_INFOS = [
  {
    recordTypeId: '012000000000000AAA',
    developerName: 'Master',
    name: 'Master',
    available: true,
    active: true,
    master: true,
    defaultRecordTypeMapping: false,
  },
  {
    recordTypeId: PERSON_TYPE,
    developerName: 'PersonAccount',
    name: 'Person Account',
    available: true,
    active: true,
    master: false,
    defaultRecordTypeMapping: false,
  },
  {
    recordTypeId: BUSINESS_TYPE,
    developerName: 'Customer',
    name: 'Customer',
    available: true,
    active: true,
    master: false,
    defaultRecordTypeMapping: true,
  },
  {
    recordTypeId: fakeId('012', 3),
    developerName: 'Closed',
    name: 'Closed',
    available: false,
    active: true,
    master: false,
    defaultRecordTypeMapping: false,
  },
];

const PERSONS = [{ id: PERSON_TYPE, developerName: 'PersonAccount' }];

/** A template seeding accounts with these rules, then contacts. */
function template(accountRules: SeedTemplate['objects'][number]['fieldRules']): SeedTemplate {
  const object = (
    objectApiName: string,
    fieldRules: SeedTemplate['objects'][number]['fieldRules'],
    insertOrder: number,
  ) => ({
    objectApiName,
    recordCount: 5,
    fieldRules,
    excludedFields: [],
    insertOrder,
    batchSize: 200,
  });
  return {
    id: 'tpl',
    name: 'seed-from-ui',
    description: '',
    version: 1,
    strategy: 'faker',
    objects: [
      object('Account', accountRules, 0),
      object(
        'Contact',
        [{ fieldApiName: 'LastName', ruleType: 'faker', config: { fakerMethod: 'lastName' } }],
        1,
      ),
    ],
    tags: [],
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
}

/** Every rule a wizard gives an account of an org with person accounts. */
const ACCOUNT_RULES: SeedTemplate['objects'][number]['fieldRules'] = [
  { fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company' } },
  { fieldApiName: 'Phone', ruleType: 'faker', config: { fakerMethod: 'phone' } },
  { fieldApiName: 'FirstName', ruleType: 'faker', config: { fakerMethod: 'firstName' } },
  { fieldApiName: 'LastName', ruleType: 'faker', config: { fakerMethod: 'lastName' } },
  { fieldApiName: 'PersonEmail', ruleType: 'faker', config: { fakerMethod: 'email' } },
];

const fieldsOf = (seeded: SeedTemplate, object: string): string[] =>
  seeded.objects.find((o) => o.objectApiName === object)?.fieldRules.map((r) => r.fieldApiName) ??
  [];

describe('personRecordTypes', () => {
  it('reads the person account record types, and none from an org that has no person accounts', async () => {
    const query = vi.fn(async () => ({
      records: [{ Id: PERSON_TYPE, DeveloperName: 'PersonAccount' }],
    }));
    expect(await personRecordTypes({ query })).toEqual(PERSONS);

    const refusing = {
      query: async () => {
        throw new Error("INVALID_FIELD: No such column 'IsPersonType' on entity 'RecordType'");
      },
    };
    expect(await personRecordTypes(refusing)).toEqual([]);
  });
});

describe('seedRecordTypeOptions', () => {
  it('offers the active types open to the user, never the master, a person account’s marked', () => {
    expect(seedRecordTypeOptions('Account', ACCOUNT_INFOS, PERSONS)).toEqual([
      {
        recordTypeId: PERSON_TYPE,
        developerName: 'PersonAccount',
        label: 'Person Account',
        person: true,
        isDefault: false,
      },
      {
        recordTypeId: BUSINESS_TYPE,
        developerName: 'Customer',
        label: 'Customer',
        person: false,
        isDefault: true,
      },
    ]);
  });

  it('marks no type of another object as a person account’s', () => {
    expect(seedRecordTypeOptions('Opportunity', ACCOUNT_INFOS, PERSONS).some((o) => o.person)).toBe(
      false,
    );
    expect(seedRecordTypeOptions('Account', undefined, PERSONS)).toEqual([]);
  });
});

describe('templateForAccountKinds', () => {
  it('writes accounts given a person type as person accounts: without Name, with a person’s fields', () => {
    const typed = template([
      ...ACCOUNT_RULES,
      { fieldApiName: 'RecordTypeId', ruleType: 'static', config: { staticValue: PERSON_TYPE } },
    ]);

    const kinds = templateForAccountKinds(typed, PERSONS);

    if ('refusal' in kinds) throw new Error(kinds.refusal);
    expect(fieldsOf(kinds.template, 'Account')).toEqual([
      'Phone',
      'FirstName',
      'LastName',
      'PersonEmail',
      'RecordTypeId',
    ]);
    expect(kinds.personObjects).toEqual(['Account']);
    expect(fieldsOf(kinds.template, 'Contact')).toEqual(['LastName']);
  });

  it('writes accounts given no type, or a business one, as business accounts, without a person’s fields', () => {
    for (const rules of [
      ACCOUNT_RULES,
      [
        ...ACCOUNT_RULES,
        {
          fieldApiName: 'RecordTypeId',
          ruleType: 'static' as const,
          config: { staticValue: BUSINESS_TYPE },
        },
      ],
    ]) {
      const kinds = templateForAccountKinds(template(rules), PERSONS);
      if ('refusal' in kinds) throw new Error(kinds.refusal);
      expect(fieldsOf(kinds.template, 'Account').filter((f) => f !== 'RecordTypeId')).toEqual([
        'Name',
        'Phone',
      ]);
      expect(kinds.personObjects).toEqual([]);
    }
  });

  it('refuses a person type and a business type taking turns, as the command line refuses them', () => {
    const kinds = templateForAccountKinds(
      template([
        ...ACCOUNT_RULES,
        {
          fieldApiName: 'RecordTypeId',
          ruleType: 'picklist_random',
          config: { picklistValues: [PERSON_TYPE, BUSINESS_TYPE.slice(0, 15)] },
        },
      ]),
      PERSONS,
    );

    expect(kinds).toEqual({
      refusal:
        'Account: PersonAccount is a person account record type and the other record types ' +
        'chosen are not: a person account and a business account take different fields. Seed ' +
        'one kind in a run.',
    });
  });

  it('leaves the template as it is in an org without person accounts', () => {
    const plain = template(ACCOUNT_RULES);

    expect(templateForAccountKinds(plain, [])).toEqual({ template: plain, personObjects: [] });
  });
});
