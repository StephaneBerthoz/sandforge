import { describe, it, expect } from 'vitest';
import { adminChangesOf, forgeGapId } from '@sandforge/shared';
import { placeholderId, type RehearsedRow } from './RehearsalWriter.js';
import { rehearsalGaps, type RefusedRow } from './rehearsalGaps.js';

function refused(
  objectApiName: string,
  fields: Record<string, unknown>,
  errors: RefusedRow['errors'],
  standsFor = 1,
  seq = 0,
): RefusedRow {
  const row: RehearsedRow = {
    seq,
    objectApiName,
    fields,
    placeholderId: placeholderId('a0X', seq),
  };
  return { row, errors, standsFor };
}

describe('the gaps of the rows a rehearsal saw refused', () => {
  it('make a rehearsal refusal of a code no read before the write reports, with the first field it named', () => {
    const [gap] = rehearsalGaps([
      refused('Contact', { LastName: 'Example' }, [
        {
          statusCode: 'FIELD_INTEGRITY_EXCEPTION',
          message: 'Le champ ne convient pas',
          fields: ['MailingCountryCode', 'MailingStateCode'],
        },
      ]),
    ]);
    expect(gap).toMatchObject({
      id: forgeGapId(
        'rehearsal_refusal',
        'Contact',
        'MailingCountryCode',
        undefined,
        'FIELD_INTEGRITY_EXCEPTION',
      ),
      kind: 'rehearsal_refusal',
      severity: 'blocking',
      source: 'rehearsal',
      objectApiName: 'Contact',
      field: 'MailingCountryCode',
      value: 'FIELD_INTEGRITY_EXCEPTION',
      rows: 1,
      decisions: ['leave_empty', 'exclude_object', 'ignore'],
    });
    expect(gap.detail).toEqual({
      statusCode: 'FIELD_INTEGRITY_EXCEPTION',
      fields: ['MailingCountryCode', 'MailingStateCode'],
      message: 'Le champ ne convient pas',
      rowsOfTheRun: 1,
    });
  });

  it('count how many sample rows got the same verdict, and the rows of the run they stand for', () => {
    const error = {
      statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
      message: 'Flow fault',
      fields: [],
    };
    const [gap] = rehearsalGaps([
      refused('Case', { Subject: 'A' }, [error], 3, 0),
      refused('Case', { Subject: 'B' }, [error], 7, 1),
    ]);
    expect(gap.rows).toBe(2);
    expect(gap.detail?.['rowsOfTheRun']).toBe(10);
    expect(gap.field).toBeUndefined();
    expect(gap.decisions).toEqual(['exclude_object', 'ignore']);
  });

  it('take a validation rule naming a field as a warning: the run writes the row again without it', () => {
    const [gap] = rehearsalGaps([
      refused('Account', { Phone: '0102030405' }, [
        {
          statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          message: 'Format attendu',
          fields: ['Phone'],
        },
      ]),
    ]);
    expect(gap.severity).toBe('warning');
    expect(gap.defaultDecision).toBe('leave_empty');
    expect(gap.detail?.['writtenWithoutTheField']).toBe(true);
  });

  it('take a required field refusal as a required field gap per field, with the id the simulation gives it', () => {
    const gaps = rehearsalGaps([
      refused('Opportunity', { Name: 'A' }, [
        {
          statusCode: 'REQUIRED_FIELD_MISSING',
          message: 'Required fields are missing: [StageName, CloseDate]',
          fields: ['StageName', 'CloseDate'],
        },
      ]),
    ]);
    expect(gaps.map((g) => g.id).sort()).toEqual(
      [
        forgeGapId('required_field_missing', 'Opportunity', 'CloseDate'),
        forgeGapId('required_field_missing', 'Opportunity', 'StageName'),
      ].sort(),
    );
    expect(
      gaps.every((g) => g.kind === 'required_field_missing' && g.severity === 'blocking'),
    ).toBe(true);
    expect(gaps[0].detail?.['statusCode']).toBe('REQUIRED_FIELD_MISSING');
  });

  it('take a restricted picklist refusal as a refused value of the record type the row goes in with', () => {
    const [gap] = rehearsalGaps(
      [
        refused('Case', { Origin: 'Fax', RecordTypeId: '012000000000777AAA' }, [
          {
            statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
            message: 'bad value: Fax',
            fields: ['Origin'],
          },
        ]),
      ],
      new Map([['012000000000777', 'Support']]),
    );
    expect(gap).toMatchObject({
      id: forgeGapId('picklist_value_refused', 'Case', 'Origin', 'Support', 'Fax'),
      kind: 'picklist_value_refused',
      recordType: 'Support',
      value: 'Fax',
      severity: 'warning',
    });
  });

  describe('a restricted picklist refusal, against what the target describes of the field', () => {
    const faxRefused = (fields: Record<string, unknown>): RefusedRow =>
      refused('Case', fields, [
        {
          statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
          message: 'bad value for restricted picklist field: Fax',
          fields: ['Origin'],
        },
      ]);
    const support = new Map([['012000000000777', 'Support']]);
    const onSupport = { Origin: 'Fax', RecordTypeId: '012000000000777AAA' };

    it('says a value the field holds was refused for the record type, and the admin list selects it for that record type', () => {
      // Carried with no reason, the gap read in the list for the target's
      // admin as "add or activate the value" where the field already held it.
      const gaps = rehearsalGaps(
        [faxRefused(onSupport)],
        support,
        new Map([['Case', new Map([['Origin', { values: ['Phone', 'Fax', 'Web'] }]])]]),
      );

      expect(gaps[0].detail?.['reason']).toBe('record-type');
      expect(adminChangesOf(gaps)).toEqual([
        {
          objectApiName: 'Case',
          recordType: 'Support',
          changes: [
            expect.objectContaining({
              change: 'select_picklist_value',
              field: 'Origin',
              value: 'Fax',
              setup:
                'Setup > Object Manager > Case > Record Types > Support > Origin > Edit: add ' +
                '"Fax" to the selected values',
            }),
          ],
        },
      ]);
    });

    it('says a value the field does not hold is missing from it, and the admin list adds it, then selects it for the record type', () => {
      const gaps = rehearsalGaps(
        [faxRefused(onSupport)],
        support,
        new Map([['Case', new Map([['Origin', { values: ['Phone', 'Web'] }]])]]),
      );

      expect(gaps[0].detail?.['reason']).toBe('not-in-target');
      expect(adminChangesOf(gaps)[0].changes[0]).toMatchObject({
        change: 'add_picklist_value',
        setup:
          'Setup > Object Manager > Case > Fields & Relationships > Origin > Values: add or ' +
          'activate "Fax", then select it for record type Support',
      });
    });

    it('says no reason it cannot tell: no describe of the field, a dependent field, a row with no record type', () => {
      const held = new Map([['Case', new Map([['Origin', { values: ['Fax'] }]])]]);
      const dependent = new Map([
        ['Case', new Map([['Origin', { values: ['Fax'], controllerName: 'Type' }]])],
      ]);

      const reasons = [
        rehearsalGaps([faxRefused(onSupport)], support),
        rehearsalGaps([faxRefused(onSupport)], support, dependent),
        rehearsalGaps([faxRefused({ Origin: 'Fax' })], support, held),
      ].map(([gap]) => gap.detail?.['reason']);

      expect(reasons).toEqual([undefined, undefined, undefined]);
    });
  });

  it('say a text too long by its length, never by what it says nor by the message that quotes it', () => {
    const text = 'A secret note '.repeat(30);
    const [gap] = rehearsalGaps([
      refused('Account', { Description__c: text }, [
        {
          statusCode: 'STRING_TOO_LONG',
          message: `Data value too large: ${text}`,
          fields: ['Description__c'],
        },
      ]),
    ]);
    expect(gap.id).toBe(forgeGapId('value_too_long', 'Account', 'Description__c'));
    expect(gap.detail?.['valueLength']).toBe(text.length);
    expect(JSON.stringify(gap)).not.toContain('secret');
  });

  it('take the row’s own values out of a message that quotes them', () => {
    const [gap] = rehearsalGaps([
      refused('Lead', { Company: 'Initech', Email: 'someone@example.invalid' }, [
        {
          statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
          message: 'Lead Initech for someone@example.invalid failed',
          fields: [],
        },
      ]),
    ]);
    expect(gap.detail?.['message']).toBe('Lead … for … failed');
  });

  it('take a unique value refusal naming its field as a collision, and leave out its message', () => {
    const [gap] = rehearsalGaps([
      refused('Account', { External__c: 'X-1' }, [
        {
          statusCode: 'DUPLICATE_VALUE',
          message: 'duplicate value found: External__c on record with id: 001000000000001',
          fields: ['External__c'],
        },
      ]),
    ]);
    expect(gap.kind).toBe('unique_value_collision');
    expect(gap.detail?.['message']).toBeUndefined();
    // The run links such a row to the record the target holds: no row is lost.
    expect(gap.severity).toBe('warning');
  });

  it('take a row the run links to the record its refusal names as a warning, even when no field is named', () => {
    // The target's unique index on an external id names no field: read as a
    // refusal, it was a blocking gap of a row the real run linked.
    const entry = refused('Account', { Ext_Id__c: 'X-1' }, [
      {
        statusCode: 'DUPLICATE_VALUE',
        message:
          'duplicate value found: Ext_Id__c duplicates value on record with id: 001000000000777',
        fields: [],
      },
    ]);
    const [gap] = rehearsalGaps([{ ...entry, linked: true }]);
    expect(gap).toMatchObject({
      id: forgeGapId('unique_value_collision', 'Account'),
      kind: 'unique_value_collision',
      severity: 'warning',
      decisions: ['exclude_object', 'ignore'],
      defaultDecision: 'ignore',
    });
    expect(gap.detail).toMatchObject({
      linkedToTheRecordItNames: true,
      statusCode: 'DUPLICATE_VALUE',
    });
    expect(gap.detail?.['message']).toBeUndefined();
    // Not linked, the same refusal blocks.
    expect(rehearsalGaps([entry])[0]).toMatchObject({
      kind: 'rehearsal_refusal',
      severity: 'blocking',
    });
  });

  it('count a row refused twice on the same gap once', () => {
    const [gap] = rehearsalGaps([
      refused('Account', {}, [
        { statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'a', fields: ['X__c'] },
        { statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'b', fields: ['X__c'] },
      ]),
    ]);
    expect(gap.rows).toBe(1);
  });

  it('read a refusal that gave no error as an unknown error', () => {
    const [gap] = rehearsalGaps([refused('Account', {}, [])]);
    expect(gap.value).toBe('UNKNOWN_ERROR');
  });
});
