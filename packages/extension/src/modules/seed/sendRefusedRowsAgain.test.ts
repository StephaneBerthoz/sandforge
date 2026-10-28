import { describe, it, expect, vi } from 'vitest';
import { sendRefusedRowsAgain } from './sendRefusedRowsAgain';
import type { InsertResult, InsertedRow } from './SeedOrchestrator';

const PHONE_RULE = {
  statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  message: 'Phone must be written +33 X XX XX XX XX.',
  fields: ['Phone'],
};

/** A row refused with these errors, as the REST path answers it. */
function refused(...details: Array<typeof PHONE_RULE>): InsertedRow {
  return {
    error: details.map((d) => `${d.statusCode}: ${d.message}`).join('; '),
    errorDetails: details,
  };
}

/** The lists of an insert's answer, read off its rows. */
function answer(rows: InsertedRow[], extra: Partial<InsertResult> = {}): InsertResult {
  return {
    successIds: rows.flatMap((r) => (r.id ? [r.id] : [])),
    errors: rows.flatMap((r) => (r.id ? [] : [r.error ?? ''])),
    rows,
    ...extra,
  };
}

/**
 * A target with a phone format rule, and another on the mobile phone: a row
 * holding either in the wrong form is refused, for the first rule it breaks.
 */
function ruledTarget() {
  let next = 0;
  return vi.fn(async (rows: Record<string, unknown>[]) =>
    answer(
      rows.map((row): InsertedRow => {
        if (typeof row.Phone === 'string' && !row.Phone.startsWith('+33')) {
          return refused(PHONE_RULE);
        }
        if (typeof row.MobilePhone === 'string' && !row.MobilePhone.startsWith('+33')) {
          return refused({
            ...PHONE_RULE,
            message: 'Mobile must be French.',
            fields: ['MobilePhone'],
          });
        }
        return { id: `003${String(++next).padStart(15, '0')}` };
      }),
    ),
  );
}

describe('sendRefusedRowsAgain', () => {
  it('writes a row refused on a field a validation rule named again without it, and counts it written', async () => {
    const send = ruledTarget();
    const records = [
      { LastName: 'A', Phone: '+1 555 0100' },
      { LastName: 'B', Phone: '+33 1 23 45 67 89' },
    ];
    const first = await send(records);

    const { result, written, unsent } = await sendRefusedRowsAgain(send, records, first, new Set());

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual([{ LastName: 'A' }]);
    expect(result.successIds).toHaveLength(2);
    expect(result.errors).toEqual([]);
    expect(written).toEqual({
      rows: 1,
      fields: [
        {
          field: 'Phone',
          refusedBy: 'validation-rule',
          reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33 X XX XX XX XX.',
          rows: 1,
        },
      ],
    });
    expect(unsent).toEqual([]);
  });

  it('goes again a second time for the next field the target names, never a third', async () => {
    // The target names one refusal at a time: the phone first, then the mobile.
    const send = ruledTarget();
    const records = [{ LastName: 'A', Phone: '+1 555 0100', MobilePhone: '+1 555 0101' }];

    const { result, written } = await sendRefusedRowsAgain(
      send,
      records,
      await send(records),
      new Set(),
    );

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0]).toEqual([{ LastName: 'A' }]);
    expect(result.successIds).toHaveLength(1);
    expect(written?.fields.map((f) => f.field)).toEqual(['Phone', 'MobilePhone']);
  });

  it('keeps the target’s last word on a row refused a third time', async () => {
    const send = vi.fn(async (rows: Record<string, unknown>[]) =>
      answer(rows.map(() => refused({ ...PHONE_RULE, fields: ['LastName'] }))),
    );
    const records = [{ LastName: 'A', FirstName: 'B' }];
    const rules = [
      { ...PHONE_RULE, message: 'first', fields: ['FirstName'] },
      { ...PHONE_RULE, message: 'second', fields: ['LastName'] },
    ];
    send
      .mockResolvedValueOnce(answer([refused(rules[0])]))
      .mockResolvedValueOnce(answer([refused(rules[1])]))
      .mockResolvedValueOnce(answer([refused({ ...PHONE_RULE, message: 'last', fields: [] })]));

    const first = await send(records);
    const { result, written } = await sendRefusedRowsAgain(send, records, first, new Set());

    expect(send).toHaveBeenCalledTimes(3);
    expect(result.successIds).toEqual([]);
    expect(result.errors).toEqual(['FIELD_CUSTOM_VALIDATION_EXCEPTION: last']);
    expect(written).toBeUndefined();
  });

  it('never sends a row again without a field the run settled', async () => {
    // A contact refused on the account its relation placed it under would
    // stand alone, written without it.
    const send = vi.fn(async () => answer([refused({ ...PHONE_RULE, fields: ['AccountId'] })]));
    const records = [{ LastName: 'A', AccountId: '001000000000001AAA' }];

    const { result } = await sendRefusedRowsAgain(
      send,
      records,
      await send(),
      new Set(['AccountId', 'RecordTypeId']),
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(1);
  });

  it('sends nothing again for an error that names no field, or one no rule of the three gives', async () => {
    const send = vi.fn(async () =>
      answer([
        refused({ ...PHONE_RULE, fields: [] }),
        refused({
          statusCode: 'REQUIRED_FIELD_MISSING',
          message: 'Required',
          fields: ['LastName'],
        }),
      ]),
    );
    const records = [{ Phone: 'x' }, { Phone: 'y' }];

    const { result } = await sendRefusedRowsAgain(send, records, await send(), new Set());

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(2);
  });

  it('sends nothing again when the insert gave no answer per row, as the Bulk API does', async () => {
    const send = vi.fn();
    const first: InsertResult = { successIds: [], errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'] };

    const sent = await sendRefusedRowsAgain(send, [{ Phone: 'x' }], first, new Set());

    expect(send).not.toHaveBeenCalled();
    expect(sent.result).toBe(first);
  });

  it('sends nothing again once the run is cancelled', async () => {
    const send = ruledTarget();
    const records = [{ LastName: 'A', Phone: '+1 555 0100' }];

    const { result } = await sendRefusedRowsAgain(
      send,
      records,
      await send(records),
      new Set(),
      () => true,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(1);
  });

  it('leaves the rows refused and says why when sending them again fails outright', async () => {
    const send = ruledTarget();
    const records = [{ LastName: 'A', Phone: '+1 555 0100' }];
    const first = await send(records);
    send.mockRejectedValueOnce(new Error('socket hang up'));

    const { result, unsent } = await sendRefusedRowsAgain(send, records, first, new Set());

    expect(result.errors).toEqual([first.errors[0]]);
    expect(unsent).toEqual([
      '1 record(s) refused on Phone could not be written again without it: socket hang up',
    ]);
  });

  it('counts what a cancel let through of the rows sent again, and says the insert stopped', async () => {
    const send = ruledTarget();
    const records = [
      { LastName: 'A', Phone: '+1 555 0100' },
      { LastName: 'B', Phone: '+1 555 0101' },
    ];
    const first = await send(records);
    send.mockResolvedValueOnce(answer([{ id: '003000000000000099' }], { stopped: true }));

    const { result } = await sendRefusedRowsAgain(send, records, first, new Set());

    expect(result.stopped).toBe(true);
    expect(result.successIds).toEqual(['003000000000000099']);
    expect(result.errors).toHaveLength(1);
  });

  it('answers each row at the place it was first sent, a row written the second time included', async () => {
    // What a relation by key reads a row's id from: the record at that place.
    const send = ruledTarget();
    const records = [
      { LastName: 'A', Phone: '+33 1 23 45 67 89' },
      { LastName: 'B', Phone: '+1 555 0100' },
      { LastName: 'C', Phone: '+33 1 23 45 67 90' },
    ];
    const first = await send(records);

    const { result } = await sendRefusedRowsAgain(send, records, first, new Set());

    const [secondTry] = (await send.mock.results[1].value).rows ?? [];
    expect(result.rows?.map((row) => row.id)).toEqual([
      first.rows?.[0].id,
      secondTry.id,
      first.rows?.[2].id,
    ]);
    expect(result.rows?.some((row) => row.unmatched)).toBe(false);
  });

  it('marks the rows of a second answer read off its lists, which do not say whose each id is', async () => {
    const send = ruledTarget();
    const records = [
      { LastName: 'A', Phone: '+1 555 0100' },
      { LastName: 'B', Phone: '+1 555 0101' },
    ];
    const first = await send(records);
    send.mockResolvedValueOnce({
      successIds: ['003000000000000098', '003000000000000099'],
      errors: [],
    });

    const { result } = await sendRefusedRowsAgain(send, records, first, new Set());

    expect(result.successIds).toHaveLength(2);
    expect(result.rows?.map((row) => row.unmatched)).toEqual([true, true]);
  });

  it('takes the answer to one row sent again alone as that row’s, read off its lists or not', async () => {
    const send = ruledTarget();
    const records = [{ LastName: 'A', Phone: '+1 555 0100' }, { LastName: 'B' }];
    const first = await send(records);
    send.mockResolvedValueOnce({ successIds: ['003000000000000099'], errors: [] });

    const { result } = await sendRefusedRowsAgain(send, records, first, new Set());

    expect(result.rows?.[0]).toEqual({ id: '003000000000000099' });
  });
});
