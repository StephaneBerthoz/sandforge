import { describe, it, expect } from 'vitest';
import {
  canonicalRecordId,
  duplicateRuleMatchIds,
  existingRecordOf,
  formatSaveError,
  recordIdInDuplicateValue,
  toSaveOutcome,
  toSaveOutcomes,
} from './existingRecordMatch.js';

/** A fake Account id, in both forms (the checksum is the real algorithm's). */
const ACCOUNT_15 = '001Fk00000AbCdE';
const ACCOUNT_18 = '001Fk00000AbCdEIAV';
const OTHER_ACCOUNT_18 = '001Fk00000QrStUIAV';
const CONTACT_18 = '003Fk00000MnOpQIAV';

/** A unique index refusing a row, as sObject Collections returns it. */
function uniqueIndexRefusal(id: string): Record<string, unknown> {
  return {
    success: false,
    errors: [
      {
        statusCode: 'DUPLICATE_VALUE',
        message: `duplicate value found: ExternalKey__c duplicates value on record with id: ${id}`,
        fields: [],
      },
    ],
  };
}

/** A duplicate rule set to block, refusing a row over the records it matched. */
function duplicateRuleRefusal(
  matchResults: Array<{ entityType?: string; records: Array<{ type?: string; Id: string }> }>,
): Record<string, unknown> {
  return {
    success: false,
    errors: [
      {
        statusCode: 'DUPLICATES_DETECTED',
        message: 'Use one of these records?',
        fields: [],
        duplicateResult: {
          allowSave: false,
          duplicateRule: 'Standard_Account_Duplicate_Rule',
          duplicateRuleEntityType: 'Account',
          errorMessage:
            "You're creating a duplicate record. We recommend you use an existing record instead.",
          matchResults: matchResults.map((m) => ({
            ...(m.entityType ? { entityType: m.entityType } : {}),
            errors: [],
            matchEngine: 'FuzzyMatchEngine',
            matchRecords: m.records.map((r) => ({
              additionalInformation: [],
              fieldDiffs: [],
              matchConfidence: 100,
              record: {
                ...(r.type
                  ? {
                      attributes: {
                        type: r.type,
                        url: `/services/data/v60.0/sobjects/${r.type}/${r.Id}`,
                      },
                    }
                  : {}),
                Id: r.Id,
              },
            })),
            rule: 'Standard_Account_Match_Rule_v1_0',
            size: m.records.length,
            success: true,
          })),
          success: false,
        },
      },
    ],
  };
}

describe('canonicalRecordId', () => {
  it('extends a 15-character id with its checksum', () => {
    expect(canonicalRecordId(ACCOUNT_15)).toBe(ACCOUNT_18);
  });

  it('keeps an 18-character id whose checksum matches its first fifteen characters', () => {
    expect(canonicalRecordId(ACCOUNT_18)).toBe(ACCOUNT_18);
    expect(canonicalRecordId('012000000000000AAA')).toBe('012000000000000AAA');
  });

  it('refuses an 18-character id whose checksum does not match', () => {
    expect(canonicalRecordId('001Fk00000AbCdEAAA')).toBeUndefined();
  });

  it('refuses anything that is not 15 or 18 letters and digits', () => {
    expect(canonicalRecordId('001Fk00000AbCdEI')).toBeUndefined();
    expect(canonicalRecordId('<unknown>')).toBeUndefined();
    expect(canonicalRecordId('001Fk00000AbC-E')).toBeUndefined();
    expect(canonicalRecordId('')).toBeUndefined();
  });

  it('refuses an id of another object when the key prefix is known', () => {
    expect(canonicalRecordId(ACCOUNT_15, '001')).toBe(ACCOUNT_18);
    expect(canonicalRecordId(CONTACT_18, '001')).toBeUndefined();
  });
});

describe('recordIdInDuplicateValue', () => {
  it('reads the id from the REST message', () => {
    expect(
      recordIdInDuplicateValue(
        `duplicate value found: ExternalKey__c duplicates value on record with id: ${ACCOUNT_15}`,
      ),
    ).toBe(ACCOUNT_15);
  });

  it('reads the id from a Bulk API sf__Error, where the fields follow it', () => {
    expect(
      recordIdInDuplicateValue(
        `DUPLICATE_VALUE:duplicate value found: ExternalKey__c duplicates value on record with id: ${ACCOUNT_15}:--`,
      ),
    ).toBe(ACCOUNT_15);
  });

  it('reads nothing when Salesforce hides the record behind <unknown>', () => {
    expect(
      recordIdInDuplicateValue(
        'DUPLICATE_VALUE: duplicate value found: <unknown> duplicates value on record with id: <unknown>',
      ),
    ).toBeUndefined();
  });

  it('reads nothing from a token longer than an id', () => {
    expect(
      recordIdInDuplicateValue(
        `duplicate value found: Key__c duplicates value on record with id: ${ACCOUNT_18}X`,
      ),
    ).toBeUndefined();
  });
});

describe('formatSaveError', () => {
  it('prefixes the message with the status code sObject Collections sends', () => {
    expect(
      formatSaveError({
        statusCode: 'REQUIRED_FIELD_MISSING',
        message: 'Required fields are missing: [Name]',
        fields: ['Name'],
      }),
    ).toBe('REQUIRED_FIELD_MISSING: Required fields are missing: [Name]');
  });

  it('reads the error code a single-record write carries instead', () => {
    expect(
      formatSaveError({ errorCode: 'DUPLICATE_VALUE', message: 'duplicate value found' }),
    ).toBe('DUPLICATE_VALUE: duplicate value found');
  });

  it('keeps a bare message, and a string, as they are', () => {
    expect(formatSaveError({ message: 'Something failed' })).toBe('Something failed');
    expect(formatSaveError('INVALID_FIELD: No such column')).toBe('INVALID_FIELD: No such column');
  });
});

describe('duplicateRuleMatchIds', () => {
  it('reads the matched record of the object written', () => {
    const refusal = duplicateRuleRefusal([
      { entityType: 'Account', records: [{ type: 'Account', Id: ACCOUNT_18 }] },
    ]);
    const [error] = refusal.errors as unknown[];

    expect(duplicateRuleMatchIds(error, 'Account')).toEqual([ACCOUNT_18]);
  });

  it('leaves out a record another object matched, as a lead rule matching contacts does', () => {
    const refusal = duplicateRuleRefusal([
      { entityType: 'Contact', records: [{ type: 'Contact', Id: CONTACT_18 }] },
    ]);
    const [error] = refusal.errors as unknown[];

    expect(duplicateRuleMatchIds(error, 'Lead')).toEqual([]);
  });

  it('leaves out a match that does not say which object it is of', () => {
    const refusal = duplicateRuleRefusal([{ records: [{ Id: ACCOUNT_18 }] }]);
    const [error] = refusal.errors as unknown[];

    expect(duplicateRuleMatchIds(error, 'Account')).toEqual([]);
  });

  it('reads nothing from an error that is not a duplicate rule', () => {
    const [error] = uniqueIndexRefusal(ACCOUNT_15).errors as unknown[];

    expect(duplicateRuleMatchIds(error, 'Account')).toEqual([]);
  });
});

describe('toSaveOutcome', () => {
  it('keeps the id of a record written', () => {
    expect(toSaveOutcome({ id: ACCOUNT_18, success: true, errors: [] }, 'Account')).toEqual({
      id: ACCOUNT_18,
      success: true,
      errors: [],
    });
  });

  it('formats a refusal with its code and carries the records a rule matched', () => {
    const outcome = toSaveOutcome(
      duplicateRuleRefusal([
        { entityType: 'Account', records: [{ type: 'Account', Id: ACCOUNT_18 }] },
      ]),
      'Account',
    );

    expect(outcome).toEqual({
      id: '',
      success: false,
      errors: ['DUPLICATES_DETECTED: Use one of these records?'],
      duplicateMatchIds: [ACCOUNT_18],
    });
  });

  it('reports something that is not a save result as a refusal', () => {
    expect(toSaveOutcome({ id: ACCOUNT_18 }, 'Account').success).toBe(false);
    expect(toSaveOutcome(null, 'Account').success).toBe(false);
  });

  it('reads a single result as a list of one', () => {
    expect(toSaveOutcomes({ id: ACCOUNT_18, success: true, errors: [] }, 'Account')).toHaveLength(
      1,
    );
    expect(
      toSaveOutcomes(
        [{ id: ACCOUNT_18, success: true, errors: [] }, uniqueIndexRefusal(ACCOUNT_15)],
        'Account',
      ).map((o) => o.success),
    ).toEqual([true, false]);
  });
});

describe('existingRecordOf', () => {
  it('links a row a unique index refused to the record it names', () => {
    const outcome = toSaveOutcome(uniqueIndexRefusal(ACCOUNT_15), 'Account');

    expect(existingRecordOf(outcome, '001')).toEqual({ kind: 'linked', id: ACCOUNT_18 });
  });

  it('links a row a blocking duplicate rule refused to its single match', () => {
    const outcome = toSaveOutcome(
      duplicateRuleRefusal([
        { entityType: 'Account', records: [{ type: 'Account', Id: ACCOUNT_18 }] },
      ]),
      'Account',
    );

    expect(existingRecordOf(outcome, '001')).toEqual({ kind: 'linked', id: ACCOUNT_18 });
  });

  it('links a row Bulk API refused, from its sf__Error text', () => {
    const outcome = {
      success: false,
      errors: [
        `DUPLICATE_VALUE:duplicate value found: ExternalKey__c duplicates value on record with id: ${ACCOUNT_15}:--`,
      ],
    };

    expect(existingRecordOf(outcome, null)).toEqual({ kind: 'linked', id: ACCOUNT_18 });
  });

  it('cannot identify a record Salesforce hides behind <unknown>', () => {
    const outcome = toSaveOutcome(
      {
        success: false,
        errors: [
          {
            statusCode: 'DUPLICATE_VALUE',
            message:
              'duplicate value found: <unknown> duplicates value on record with id: <unknown>',
            fields: [],
          },
        ],
      },
      'AccountContactRelation',
    );

    expect(existingRecordOf(outcome, '07k')).toEqual({ kind: 'unidentified' });
  });

  it('cannot identify a record when a rule matched two of them', () => {
    const outcome = toSaveOutcome(
      duplicateRuleRefusal([
        {
          entityType: 'Account',
          records: [
            { type: 'Account', Id: ACCOUNT_18 },
            { type: 'Account', Id: OTHER_ACCOUNT_18 },
          ],
        },
      ]),
      'Account',
    );

    expect(existingRecordOf(outcome, '001')).toEqual({ kind: 'unidentified' });
  });

  it('cannot identify a record when the rule matched only another object', () => {
    const outcome = toSaveOutcome(
      duplicateRuleRefusal([
        { entityType: 'Contact', records: [{ type: 'Contact', Id: CONTACT_18 }] },
      ]),
      'Lead',
    );

    expect(existingRecordOf(outcome, '00Q')).toEqual({ kind: 'unidentified' });
  });

  it('cannot identify a record whose id belongs to another object or fails its checksum', () => {
    expect(
      existingRecordOf(toSaveOutcome(uniqueIndexRefusal(CONTACT_18), 'Account'), '001'),
    ).toEqual({
      kind: 'unidentified',
    });
    expect(
      existingRecordOf(toSaveOutcome(uniqueIndexRefusal('001Fk00000AbCdEAAA'), 'Account'), '001'),
    ).toEqual({ kind: 'unidentified' });
  });

  it('treats a 15- and an 18-character form of one record as one candidate', () => {
    const outcome = {
      success: false,
      errors: [
        `DUPLICATE_VALUE: duplicate value found: Key__c duplicates value on record with id: ${ACCOUNT_15}`,
        `DUPLICATE_VALUE: duplicate value found: Code__c duplicates value on record with id: ${ACCOUNT_18}`,
      ],
    };

    expect(existingRecordOf(outcome, '001')).toEqual({ kind: 'linked', id: ACCOUNT_18 });
  });

  it('says nothing about a row refused for a reason besides the duplicate', () => {
    const outcome = {
      success: false,
      errors: [
        `DUPLICATE_VALUE: duplicate value found: Key__c duplicates value on record with id: ${ACCOUNT_15}`,
        'REQUIRED_FIELD_MISSING: Required fields are missing: [Name]',
      ],
    };

    expect(existingRecordOf(outcome, '001')).toEqual({ kind: 'none' });
  });

  it('says nothing about a row that was written or refused for another reason', () => {
    expect(existingRecordOf({ success: true, errors: [] }, '001')).toEqual({ kind: 'none' });
    expect(
      existingRecordOf(
        { success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Bad'] },
        '001',
      ),
    ).toEqual({ kind: 'none' });
    expect(existingRecordOf({ success: false, errors: [] }, '001')).toEqual({ kind: 'none' });
  });

  it('does not read a message that only names the code without the record', () => {
    expect(
      existingRecordOf(
        { success: false, errors: ['DUPLICATE_VALUE: duplicate value found'] },
        '001',
      ),
    ).toEqual({ kind: 'unidentified' });
  });
});
