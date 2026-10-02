import { describe, expect, it } from 'vitest';
import type { SaveErrorDetail } from './existingRecordMatch.js';
import {
  addWrittenWithoutFields,
  heldKeyOf,
  refusedFields,
  without,
  writtenWithoutFieldsNote,
} from './refusedFields.js';

const picklist = (field: string, value = 'Gold'): SaveErrorDetail => ({
  statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
  message: `bad value for restricted picklist field: ${value}`,
  fields: [field],
});

const rule = (...fields: string[]): SaveErrorDetail => ({
  statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  message: 'Phone must be written +33…',
  fields,
});

describe('refusedFields', () => {
  it('leaves out the field a restricted picklist refused the value of, with the refusal', () => {
    expect(refusedFields([picklist('Tier__c')], { Name: 'A', Tier__c: 'Gold' }, undefined)).toEqual(
      [
        {
          field: 'Tier__c',
          refusedBy: 'restricted-picklist',
          reason:
            'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Gold',
        },
      ],
    );
  });

  it('names a field as the payload spells it, whatever case the target named it in', () => {
    expect(refusedFields([rule('phone')], { Phone: '0100' }, undefined)).toEqual([
      {
        field: 'Phone',
        refusedBy: 'validation-rule',
        reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33…',
      },
    ]);
  });

  it('leaves out every field a refusal holding both refusals names, once each', () => {
    const leftOut = refusedFields(
      [picklist('Tier__c'), rule('Phone', 'Tier__c')],
      { Tier__c: 'Gold', Phone: '0100' },
      undefined,
    );

    expect(leftOut?.map((f) => [f.field, f.refusedBy])).toEqual([
      ['Tier__c', 'restricted-picklist'],
      ['Phone', 'validation-rule'],
    ]);
  });

  it('leaves out nothing when another error refused the row too: it would be refused again', () => {
    expect(
      refusedFields(
        [
          picklist('Tier__c'),
          { statusCode: 'STRING_TOO_LONG', message: 'too long', fields: ['Name'] },
        ],
        { Name: 'A', Tier__c: 'Gold' },
        undefined,
      ),
    ).toBeUndefined();
  });

  it('leaves out nothing when the refusal names only fields the row leaves empty', () => {
    expect(refusedFields([rule('Phone')], { Phone: '' }, undefined)).toBeUndefined();
    expect(refusedFields([rule('Phone')], { Phone: null }, undefined)).toBeUndefined();
    expect(refusedFields([rule('Phone')], { Name: 'A' }, undefined)).toBeUndefined();
    expect(refusedFields([rule()], { Phone: '0100' }, undefined)).toBeUndefined();
  });

  it('never leaves out the field a row is kept by, the external id an upsert matches it by', () => {
    expect(refusedFields([rule('Code__c')], { Code__c: 'K-1' }, 'code__c')).toBeUndefined();
  });

  it('leaves out nothing of a refusal that says nothing', () => {
    expect(refusedFields(undefined, { Phone: '0100' }, undefined)).toBeUndefined();
    expect(refusedFields([], { Phone: '0100' }, undefined)).toBeUndefined();
  });
});

describe('heldKeyOf', () => {
  it('finds the key a payload gives a value to, whatever case it is named in', () => {
    expect(heldKeyOf({ Tier__c: 'Gold' }, 'TIER__C')).toBe('Tier__c');
    expect(heldKeyOf({ Tier__c: '' }, 'Tier__c')).toBeUndefined();
  });
});

describe('without', () => {
  it('drops the fields left out and leaves the payload as it was', () => {
    const payload = { Name: 'A', Tier__c: 'Gold', Phone: '0100' };

    expect(without(payload, [{ field: 'Tier__c' }, { field: 'Phone' }])).toEqual({ Name: 'A' });
    expect(payload).toEqual({ Name: 'A', Tier__c: 'Gold', Phone: '0100' });
  });
});

describe('addWrittenWithoutFields', () => {
  it('counts a field left out for the same refusal once, and what a declared rule gave it with it', () => {
    const one = {
      field: 'Tier__c',
      refusedBy: 'restricted-picklist' as const,
      reason:
        'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Gold',
      rows: 1,
      replacedWith: 'Silver',
    };
    const from = { rows: 1, fields: [one] };

    const sum = addWrittenWithoutFields(addWrittenWithoutFields(undefined, from), from);

    expect(sum).toEqual({ rows: 2, fields: [{ ...one, rows: 2 }] });
    // What was added from is left as it was.
    expect(from.fields[0].rows).toBe(1);
  });
});

describe('writtenWithoutFieldsNote', () => {
  it('says of each field how many rows went without it, what refused it and in what words', () => {
    expect(
      writtenWithoutFieldsNote({
        rows: 3,
        fields: [
          {
            field: 'Phone',
            refusedBy: 'validation-rule',
            reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: m',
            rows: 2,
          },
          { field: 'Tier__c', reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: n', rows: 1 },
        ],
      }),
    ).toBe(
      ', 2 written without Phone: a validation rule of the target refused it, FIELD_CUSTOM_VALIDATION_EXCEPTION: m' +
        ', 1 written without Tier__c: a validation rule of the target refused it, FIELD_CUSTOM_VALIDATION_EXCEPTION: n',
    );
  });

  it('says which value a declared rule gave a field in place of the one refused', () => {
    expect(
      writtenWithoutFieldsNote({
        rows: 1,
        fields: [
          {
            field: 'Tier__c',
            refusedBy: 'restricted-picklist',
            reason:
              'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Gold',
            rows: 1,
            replacedWith: 'Silver',
          },
        ],
      }),
    ).toBe(
      ', 1 written with Tier__c set to "Silver": a restricted picklist of the target refused ' +
        'its value, INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Gold',
    );
  });

  it('says nothing of rows that all went with their values', () => {
    expect(writtenWithoutFieldsNote(undefined)).toBe('');
  });
});
