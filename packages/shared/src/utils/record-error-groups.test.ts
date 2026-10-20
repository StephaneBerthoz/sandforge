import { describe, it, expect } from 'vitest';
import { groupRecordErrors, parseRecordError } from './record-error-groups.js';

describe('parseRecordError', () => {
  it('reads the code, the message and the fields of a refusal as the REST path writes it', () => {
    expect(
      parseRecordError('FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33. [Phone]'),
    ).toEqual({
      code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Phone must be written +33.',
      fields: ['Phone'],
    });
  });

  it('reads the fields a required-field refusal lists in its own message', () => {
    expect(
      parseRecordError('REQUIRED_FIELD_MISSING: Required fields are missing: [Name, StageName]'),
    ).toEqual({
      code: 'REQUIRED_FIELD_MISSING',
      message: 'Required fields are missing:',
      fields: ['Name', 'StageName'],
    });
  });

  it("reads a Bulk API job's sf__Error, the fields before its closing dashes", () => {
    expect(
      parseRecordError(
        'REQUIRED_FIELD_MISSING:Required fields are missing: [Name, StageName]:Name StageName --',
      ),
    ).toEqual({
      code: 'REQUIRED_FIELD_MISSING',
      message: 'Required fields are missing: [Name, StageName]',
      fields: ['Name', 'StageName'],
    });
    expect(parseRecordError('STANDARD_PRICE_NOT_DEFINED:No standard price defined:--')).toEqual({
      code: 'STANDARD_PRICE_NOT_DEFINED',
      message: 'No standard price defined',
      fields: [],
    });
  });

  it('reads a record refused for several reasons by the first', () => {
    expect(
      parseRecordError(
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone is wrong [Phone]; INVALID_EMAIL_ADDRESS: Email: invalid [Email] (and 2 more)',
      ),
    ).toEqual({
      code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Phone is wrong',
      fields: ['Phone'],
    });
  });

  it('keeps a text that names no code as it is', () => {
    expect(parseRecordError('Insert failed after retries')).toEqual({
      code: null,
      message: 'Insert failed after retries',
      fields: [],
    });
  });
});

describe('groupRecordErrors', () => {
  it('groups the refusals by code and fields, counted, the first of each as its example', () => {
    const errors = [
      ...Array.from({ length: 50 }, () => 'STANDARD_PRICE_NOT_DEFINED: No standard price defined'),
      'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
      'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
      'REQUIRED_FIELD_MISSING: Required fields are missing: [Email]',
    ];

    expect(groupRecordErrors(errors)).toEqual([
      {
        code: 'STANDARD_PRICE_NOT_DEFINED',
        fields: [],
        count: 50,
        example: 'STANDARD_PRICE_NOT_DEFINED: No standard price defined',
      },
      {
        code: 'REQUIRED_FIELD_MISSING',
        fields: ['LastName'],
        count: 2,
        example: 'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
      },
      {
        code: 'REQUIRED_FIELD_MISSING',
        fields: ['Email'],
        count: 1,
        example: 'REQUIRED_FIELD_MISSING: Required fields are missing: [Email]',
      },
    ]);
  });

  it('puts in one group the same refusal whatever path wrote it, and whatever value it quotes', () => {
    const groups = groupRecordErrors([
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone 01 02 is not written +33 [Phone]',
      'FIELD_CUSTOM_VALIDATION_EXCEPTION:Phone 03 04 is not written +33:Phone --',
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', count: 2 });
    expect(groups[0].example).toBe(
      'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone 01 02 is not written +33 [Phone]',
    );
  });

  it('groups texts that name no code by their words', () => {
    expect(
      groupRecordErrors([
        'Insert failed after retries',
        'Insert failed after retries',
        'Unknown insert error',
      ]).map((g) => [g.code, g.count, g.example]),
    ).toEqual([
      [null, 2, 'Insert failed after retries'],
      [null, 1, 'Unknown insert error'],
    ]);
  });

  it('keeps groups of as many refusals in the order their first came', () => {
    expect(
      groupRecordErrors(['B_CODE: b', 'A_CODE: a', 'A_CODE: a', 'B_CODE: b']).map((g) => g.code),
    ).toEqual(['B_CODE', 'A_CODE']);
  });

  it('answers no group for a run nothing refused', () => {
    expect(groupRecordErrors([])).toEqual([]);
  });
});
