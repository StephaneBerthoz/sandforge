import { describe, expect, it } from 'vitest';
import {
  fingerprintOf,
  objectFingerprintSchema,
  schemaDrift,
  type FingerprintField,
} from './checkpointFingerprint';

const FIELDS: FingerprintField[] = [
  { name: 'Id', type: 'id', createable: false, updateable: false, nillable: false },
  { name: 'Subject', type: 'string', createable: true, updateable: true, nillable: true },
  {
    name: 'WhatId',
    type: 'reference',
    createable: true,
    updateable: true,
    nillable: true,
    referenceTo: ['Opportunity', 'Account'],
  },
  { name: 'Region__c', type: 'picklist', createable: true, updateable: true, nillable: true },
];

/** {@link FIELDS} with one field replaced. */
function withField(name: string, change: Partial<FingerprintField>): FingerprintField[] {
  return FIELDS.map((field) => (field.name === name ? { ...field, ...change } : field));
}

describe('fingerprintOf', () => {
  it('prints the same fields the same, whatever order the describe lists them or their targets in', () => {
    const shuffled = [...FIELDS]
      .reverse()
      .map((field) =>
        field.referenceTo ? { ...field, referenceTo: [...field.referenceTo].reverse() } : field,
      );

    expect(fingerprintOf(shuffled)).toEqual(fingerprintOf(FIELDS));
  });

  it('keeps one hash per field, by its name, and one for the object', () => {
    const print = fingerprintOf(FIELDS);

    expect(Object.keys(print.fields)).toEqual(['Id', 'Region__c', 'Subject', 'WhatId']);
    expect(objectFingerprintSchema.parse(print)).toEqual(print);
  });

  it('prints another object whenever a field’s name, type, write flags, nillability, targets or Shield encryption change', () => {
    const before = fingerprintOf(FIELDS).digest;
    const changes: FingerprintField[][] = [
      withField('Subject', { name: 'Topic' }),
      withField('Subject', { type: 'textarea' }),
      withField('Subject', { createable: false }),
      withField('Subject', { updateable: false }),
      withField('Subject', { nillable: false }),
      withField('WhatId', { referenceTo: ['Opportunity'] }),
      withField('Subject', { encrypted: true }),
    ];

    for (const fields of changes) expect(fingerprintOf(fields).digest).not.toBe(before);
  });

  it('reads an absent flag as false, as the describe means it', () => {
    const spelled = [
      {
        name: 'Subject',
        type: 'string',
        createable: false,
        updateable: false,
        nillable: false,
        encrypted: false,
      },
    ];
    const unsaid = [{ name: 'Subject', type: 'string' }];

    expect(fingerprintOf(unsaid)).toEqual(fingerprintOf(spelled));
  });
});

describe('schemaDrift', () => {
  it('finds nothing between two prints of the same fields', () => {
    expect(schemaDrift(fingerprintOf(FIELDS), fingerprintOf([...FIELDS].reverse()))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('names a field deleted since, a field added since and a field whose type changed', () => {
    const now = [
      ...FIELDS.filter((field) => field.name !== 'Region__c'),
      {
        name: 'Priority_Score__c',
        type: 'double',
        createable: true,
        updateable: true,
        nillable: true,
      },
    ].map((field) => (field.name === 'Subject' ? { ...field, type: 'textarea' } : field));

    expect(schemaDrift(fingerprintOf(FIELDS), fingerprintOf(now))).toEqual({
      added: ['Priority_Score__c'],
      removed: ['Region__c'],
      changed: ['Subject'],
    });
  });

  it('names a field the user may no longer edit as changed', () => {
    expect(
      schemaDrift(
        fingerprintOf(FIELDS),
        fingerprintOf(withField('Region__c', { updateable: false })),
      ),
    ).toEqual({ added: [], removed: [], changed: ['Region__c'] });
  });

  it('reads a field whose name changed case only as the same field', () => {
    const now = withField('Region__c', { name: 'REGION__c' });

    expect(schemaDrift(fingerprintOf(FIELDS), fingerprintOf(now))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('compares prints read back from disk', () => {
    const kept = objectFingerprintSchema.parse(JSON.parse(JSON.stringify(fingerprintOf(FIELDS))));

    expect(
      schemaDrift(kept, fingerprintOf(withField('Subject', { nillable: false }))).changed,
    ).toEqual(['Subject']);
  });
});

describe('objectFingerprintSchema', () => {
  it('refuses prints that are not the hashes a checkpoint writes', () => {
    const print = fingerprintOf(FIELDS);

    expect(objectFingerprintSchema.safeParse({ ...print, digest: 'abc' }).success).toBe(false);
    expect(
      objectFingerprintSchema.safeParse({ ...print, fields: { Subject: 'not a hash' } }).success,
    ).toBe(false);
    expect(objectFingerprintSchema.safeParse({ digest: print.digest }).success).toBe(false);
  });
});
