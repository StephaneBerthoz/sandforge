import { describe, expect, it } from 'vitest';
import type { SaveErrorDetail } from './existingRecordMatch.js';
import {
  addWrittenWithoutFields,
  heldKeyOf,
  inactiveOwnerNamed,
  refusedFields,
  refusedOnNoField,
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

  describe('a lookup filter', () => {
    const filter = (field: string): SaveErrorDetail => ({
      statusCode: 'FIELD_FILTER_VALIDATION_EXCEPTION',
      message: 'Value does not exist or does not match filter criteria.',
      fields: [field],
    });
    const payload = { LastName: 'Doe', Preferred_Account__c: '001P', Phone: '0100' };

    it('leaves out the lookup it refused when the target lets the lookup be empty', () => {
      const mayBeEmpty = (field: string): boolean => field === 'Preferred_Account__c';

      expect(
        refusedFields([filter('preferred_account__c')], payload, undefined, mayBeEmpty),
      ).toEqual([
        {
          field: 'Preferred_Account__c',
          refusedBy: 'lookup-filter',
          reason:
            'FIELD_FILTER_VALIDATION_EXCEPTION: Value does not exist or does not match filter criteria.',
        },
      ]);
    });

    it('leaves out nothing when the target requires the lookup, or the caller does not say', () => {
      // Left out, a lookup the target requires has the row refused for want of it.
      expect(
        refusedFields([filter('Preferred_Account__c')], payload, undefined, () => false),
      ).toBeUndefined();
      expect(refusedFields([filter('Preferred_Account__c')], payload, undefined)).toBeUndefined();
      // Nor the rule's field beside it: the row would be refused again by the filter.
      expect(
        refusedFields([filter('Preferred_Account__c'), rule('Phone')], payload, undefined),
      ).toBeUndefined();
    });

    it('leaves out the lookup and the field a rule names beside it', () => {
      expect(
        refusedFields(
          [filter('Preferred_Account__c'), rule('Phone')],
          payload,
          undefined,
          () => true,
        )?.map((f) => [f.field, f.refusedBy]),
      ).toEqual([
        ['Preferred_Account__c', 'lookup-filter'],
        ['Phone', 'validation-rule'],
      ]);
    });
  });
});

describe('refusedFields, an owner the target holds inactive', () => {
  /** The owner as the source gave it, on 18 characters, and as the target's message names it, on 15. */
  const OWNER = '005AU00000AbCdEYAQ';
  const NAMED = '005AU00000AbCdE';
  const MESSAGE = `operation performed with inactive user [${NAMED}] as owner of [aeroport__c]`;
  const REASON = `INACTIVE_OWNER_OR_USER: ${MESSAGE}`;
  const inactive = (message = MESSAGE, fields: string[] = []): SaveErrorDetail => ({
    statusCode: 'INACTIVE_OWNER_OR_USER',
    message,
    fields,
  });
  const asked = { inactiveOwner: true } as const;

  it('leaves out the owner the refusal names, whatever length its id is given at', () => {
    expect(
      refusedFields([inactive()], { Name: 'Orly', OwnerId: OWNER }, undefined, undefined, asked),
    ).toEqual([{ field: 'OwnerId', refusedBy: 'inactive-owner', reason: REASON }]);
    // Named on 18 characters, the row's owner on 15: the same user.
    expect(
      refusedFields(
        [inactive(`operation performed with inactive user [${OWNER}] as owner of [aeroport__c]`)],
        { Name: 'Orly', ownerid: NAMED },
        undefined,
        undefined,
        asked,
      )?.map((f) => f.field),
    ).toEqual(['ownerid']);
  });

  it('leaves out nothing when the refusal names another user than the owner: a rule or a Flow of the target', () => {
    expect(
      refusedFields(
        [inactive('operation performed with inactive user [005AU00000ZzZzZ] as owner of [case]')],
        { Subject: 'S', OwnerId: OWNER },
        undefined,
        undefined,
        asked,
      ),
    ).toBeUndefined();
  });

  it('leaves out the owner of a refusal naming no user only when the row carries no audit field', () => {
    const unnamed = inactive('operation performed with inactive user as owner of the record');
    expect(
      refusedFields([unnamed], { Name: 'Orly', OwnerId: OWNER }, undefined, undefined, asked),
    ).toEqual([
      {
        field: 'OwnerId',
        refusedBy: 'inactive-owner',
        reason:
          'INACTIVE_OWNER_OR_USER: operation performed with inactive user as owner of the record',
      },
    ]);
    // The user it meant may be the one who made the record, or last changed it.
    expect(
      refusedFields(
        [unnamed],
        { Name: 'Orly', OwnerId: OWNER, CreatedById: '005AU00000CrEaT' },
        undefined,
        undefined,
        asked,
      ),
    ).toBeUndefined();
    expect(
      refusedFields(
        [unnamed],
        { Name: 'Orly', OwnerId: OWNER, LastModifiedById: '005AU00000MoDiF' },
        undefined,
        undefined,
        asked,
      ),
    ).toBeUndefined();
  });

  it('leaves out nothing of a row that gives no owner', () => {
    expect(
      refusedFields([inactive()], { Name: 'Orly' }, undefined, undefined, asked),
    ).toBeUndefined();
    expect(
      refusedFields([inactive()], { Name: 'Orly', OwnerId: '' }, undefined, undefined, asked),
    ).toBeUndefined();
    expect(
      refusedFields([inactive()], { Name: 'Orly', OwnerId: null }, undefined, undefined, asked),
    ).toBeUndefined();
  });

  it('never leaves out the owner when it is the field a row is kept by', () => {
    expect(
      refusedFields([inactive()], { Name: 'Orly', OwnerId: OWNER }, 'ownerid', undefined, asked),
    ).toBeUndefined();
  });

  it('leaves out nothing when the refusal names a field beside the owner', () => {
    expect(
      refusedFields(
        [inactive(MESSAGE, ['Approver__c'])],
        { Name: 'Orly', OwnerId: OWNER, Approver__c: OWNER },
        undefined,
        undefined,
        asked,
      ),
    ).toBeUndefined();
  });

  it("leaves out the owner and a rule's field of one refusal, and nothing beside an error it cannot go without", () => {
    expect(
      refusedFields(
        [rule('Phone'), inactive()],
        { Name: 'Orly', OwnerId: OWNER, Phone: '0100' },
        undefined,
        undefined,
        asked,
      )?.map((f) => [f.field, f.refusedBy]),
    ).toEqual([
      ['Phone', 'validation-rule'],
      ['OwnerId', 'inactive-owner'],
    ]);
    expect(
      refusedFields(
        [inactive(), { statusCode: 'UNKNOWN_EXCEPTION', message: 'boom', fields: [] }],
        { Name: 'Orly', OwnerId: OWNER },
        undefined,
        undefined,
        asked,
      ),
    ).toBeUndefined();
  });

  it('leaves out nothing for a caller that does not ask: Sync, Seed, Frozen and the parents copied from outside the graph', () => {
    expect(
      refusedFields([inactive()], { Name: 'Orly', OwnerId: OWNER }, undefined),
    ).toBeUndefined();
    expect(
      refusedFields([inactive()], { Name: 'Orly', OwnerId: OWNER }, undefined, () => true, {}),
    ).toBeUndefined();
  });
});

describe('inactiveOwnerNamed', () => {
  const OWNER = '005AU00000AbCdEYAQ';
  const named = (id: string): SaveErrorDetail => ({
    statusCode: 'INACTIVE_OWNER_OR_USER',
    message: `operation performed with inactive user [${id}] as owner of [servicecontract]`,
    fields: [],
  });

  it("names the row's own owner on fifteen characters, and nothing of another user or another refusal", () => {
    expect(inactiveOwnerNamed(named('005AU00000AbCdE'), { OwnerId: OWNER })).toBe(
      '005AU00000AbCdE',
    );
    expect(inactiveOwnerNamed(named('005AU00000ZzZzZ'), { OwnerId: OWNER })).toBeUndefined();
    expect(inactiveOwnerNamed(named('005AU00000AbCdE'), { Name: 'x' })).toBeUndefined();
    expect(
      inactiveOwnerNamed(
        { statusCode: 'INACTIVE_OWNER_OR_USER', message: 'inactive user', fields: [] },
        { OwnerId: OWNER },
      ),
    ).toBeUndefined();
    expect(
      inactiveOwnerNamed(
        { ...named('005AU00000AbCdE'), statusCode: 'INVALID_CROSS_REFERENCE_KEY' },
        {
          OwnerId: OWNER,
        },
      ),
    ).toBeUndefined();
  });
});

describe('refusedOnNoField', () => {
  it('tells a validation rule that named no field from one that named a field, or another error', () => {
    expect(refusedOnNoField([rule()])).toBe(true);
    expect(refusedOnNoField([rule('Phone'), rule()])).toBe(true);
    expect(refusedOnNoField([rule('Phone')])).toBe(false);
    expect(
      refusedOnNoField([{ statusCode: 'UNKNOWN_EXCEPTION', message: 'boom', fields: [] }]),
    ).toBe(false);
    expect(refusedOnNoField(undefined)).toBe(false);
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

  it('says a lookup filter refused the record a lookup names', () => {
    expect(
      writtenWithoutFieldsNote({
        rows: 1,
        fields: [
          {
            field: 'Preferred_Account__c',
            refusedBy: 'lookup-filter',
            reason: 'FIELD_FILTER_VALIDATION_EXCEPTION: Value does not exist',
            rows: 1,
          },
        ],
      }),
    ).toBe(
      ', 1 written without Preferred_Account__c: a lookup filter of the target refused the ' +
        'record it names, FIELD_FILTER_VALIDATION_EXCEPTION: Value does not exist',
    );
  });

  it('says the target held the owner it names inactive', () => {
    expect(
      writtenWithoutFieldsNote({
        rows: 2,
        fields: [
          {
            field: 'OwnerId',
            refusedBy: 'inactive-owner',
            reason:
              'INACTIVE_OWNER_OR_USER: operation performed with inactive user [005AU00000AbCdE]',
            rows: 2,
          },
        ],
      }),
    ).toBe(
      ', 2 written without OwnerId: the target holds the owner it names inactive, ' +
        'INACTIVE_OWNER_OR_USER: operation performed with inactive user [005AU00000AbCdE]',
    );
  });

  it('says nothing of rows that all went with their values', () => {
    expect(writtenWithoutFieldsNote(undefined)).toBe('');
  });
});
