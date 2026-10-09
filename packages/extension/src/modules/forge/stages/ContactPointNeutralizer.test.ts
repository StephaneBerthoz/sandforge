import { describe, it, expect } from 'vitest';
import type { FieldInfo } from '../ForgeExecutor.js';
import {
  ContactPointNeutralizer,
  EMAIL_FIELD_LENGTH,
  contactPointFieldsOf,
} from './ContactPointNeutralizer.js';

/** A source field as the describe gives it, writable. */
const field = (name: string, type: string, length?: number): FieldInfo => ({
  name,
  type,
  queryable: true,
  createable: true,
  isReference: false,
  ...(length !== undefined ? { length } : {}),
});

/** A number of the mobile range kept for fiction, with its country code. */
const FICTIONAL = /^\+3363998\d{4}$/;

/** The rows of one object, neutralized as a run writes them. */
function neutralized(
  neutralizer: ContactPointNeutralizer,
  fields: FieldInfo[],
  rows: Record<string, unknown>[],
  rename: Record<string, string> = {},
  objectApiName = 'Contact',
): Record<string, unknown>[] {
  const neutralize = neutralizer.forObject(objectApiName, fields, rename);
  const copies = rows.map((row) => ({ ...row }));
  for (const row of copies) neutralize?.(row);
  return copies;
}

describe('contactPointFieldsOf', () => {
  it('finds the email and phone fields, and the texts their API name gives to either', () => {
    const points = contactPointFieldsOf([
      field('Email', 'email', 80),
      field('MobilePhone', 'phone', 40),
      field('Notification_Email__c', 'string', 120),
      field('SMS_Number__c', 'string', 20),
      field('LastName', 'string', 80),
    ]);

    expect(points).toEqual([
      { name: 'Email', kind: 'email', typed: true, maxLength: 80 },
      { name: 'MobilePhone', kind: 'phone', typed: true, maxLength: 40 },
      { name: 'Notification_Email__c', kind: 'email', typed: false, maxLength: 120 },
      { name: 'SMS_Number__c', kind: 'phone', typed: false, maxLength: 20 },
    ]);
  });

  it('leaves a checkbox and a picklist named like a contact point alone', () => {
    expect(
      contactPointFieldsOf([
        field('Email_Opt_Out__c', 'boolean'),
        field('Phone_Type__c', 'picklist'),
      ]),
    ).toEqual([]);
  });

  it('bounds an email or a phone field the describe gives no length by its type, and a text by nothing', () => {
    expect(
      contactPointFieldsOf([
        field('Email', 'email'),
        field('Phone', 'phone'),
        field('Fax__c', 'string'),
      ]),
    ).toEqual([
      { name: 'Email', kind: 'email', typed: true, maxLength: EMAIL_FIELD_LENGTH },
      { name: 'Phone', kind: 'phone', typed: true, maxLength: 40 },
      { name: 'Fax__c', kind: 'phone', typed: false },
    ]);
  });
});

describe('ContactPointNeutralizer', () => {
  it('writes an email field’s address under .invalid, readable and never delivered', () => {
    const [row] = neutralized(
      new ContactPointNeutralizer('salt'),
      [field('Email', 'email', 80)],
      [{ Email: 'jane.doe@acme.com', LastName: 'Doe' }],
    );

    expect(row).toEqual({ Email: 'jane.doe@acme.com.invalid', LastName: 'Doe' });
  });

  it('leaves an address already under .invalid, and an empty one, and counts neither', () => {
    const neutralizer = new ContactPointNeutralizer('salt');
    const rows = neutralized(
      neutralizer,
      [field('Email', 'email', 80)],
      [{ Email: 'jane@acme.com.INVALID' }, { Email: '' }, { Email: null }],
    );

    expect(rows).toEqual([{ Email: 'jane@acme.com.INVALID' }, { Email: '' }, { Email: null }]);
    expect(neutralizer.report()).toEqual({ neutralized: true, fields: [], values: 0 });
  });

  it('gives an address the field cannot hold with the suffix a short one of its own, the same for the same address', () => {
    const long = `${'a'.repeat(66)}@acme.com`;
    const neutralizer = new ContactPointNeutralizer('salt');
    const rows = neutralized(
      neutralizer,
      [field('Email', 'email', 80)],
      [{ Email: long }, { Email: long }, { Email: `b${long}` }],
    );

    expect(String(rows[0]['Email'])).toMatch(/^user-[0-9a-f]{8}@example\.invalid$/);
    expect(rows[1]['Email']).toBe(rows[0]['Email']);
    expect(rows[2]['Email']).not.toBe(rows[0]['Email']);
  });

  it('replaces a phone field’s number by a fictional one, the same for the same number throughout the run', () => {
    const rows = neutralized(
      new ContactPointNeutralizer('salt'),
      [field('Phone', 'phone', 40), field('MobilePhone', 'phone', 40)],
      [
        { Phone: '06 12 34 56 78', MobilePhone: '06.12.34.56.78' },
        { Phone: '+44 20 7946 0958', MobilePhone: '06 12 34 56 78' },
      ],
    );

    for (const row of rows) {
      expect(String(row['Phone'])).toMatch(FICTIONAL);
      expect(String(row['MobilePhone'])).toMatch(FICTIONAL);
    }
    // Written two ways, the same number is the same fictional one.
    expect(rows[0]['MobilePhone']).toBe(rows[0]['Phone']);
    expect(rows[1]['MobilePhone']).toBe(rows[0]['Phone']);
    expect(rows[1]['Phone']).not.toBe(rows[0]['Phone']);
  });

  it('draws the numbers of each run with a key of its own', () => {
    const fields = [field('Phone', 'phone', 40)];
    const rows = [{ Phone: '0612345678' }, { Phone: '0698765432' }, { Phone: '0711223344' }];

    const once = neutralized(new ContactPointNeutralizer('first run'), fields, rows);
    const again = neutralized(new ContactPointNeutralizer('first run'), fields, rows);
    const next = neutralized(new ContactPointNeutralizer('next run'), fields, rows);

    expect(again).toEqual(once);
    expect(next).not.toEqual(once);
  });

  it('never gives two numbers of a run the same fictional one', () => {
    // Drawn freely from the 10 000 numbers of the range, 100 numbers shared
    // one about 39 % of the time, 2 000 almost always.
    const neutralizer = new ContactPointNeutralizer('salt');
    const sources = Array.from({ length: 2_000 }, (_, i) => `07${String(i).padStart(8, '0')}`);

    const rows = neutralized(
      neutralizer,
      [field('Phone', 'phone', 40)],
      sources.map((Phone) => ({ Phone })),
    );

    const drawn = rows.map((row) => String(row['Phone']));
    for (const number of drawn) expect(number).toMatch(FICTIONAL);
    expect(new Set(drawn).size).toBe(2_000);
  });

  it('gives a number met again the fictional one it got first, after other numbers took theirs', () => {
    const neutralizer = new ContactPointNeutralizer('salt');
    const sources = Array.from({ length: 500 }, (_, i) => `07${String(i).padStart(8, '0')}`);

    const rows = neutralized(
      neutralizer,
      [field('Phone', 'phone', 40), field('MobilePhone', 'phone', 40)],
      sources.map((number, i) => ({ Phone: number, MobilePhone: sources[(i + 7) % 500] })),
    );

    const byNumber = new Map(rows.map((row, i) => [sources[i], row['Phone']]));
    rows.forEach((row, i) => {
      expect(row['MobilePhone']).toBe(byNumber.get(sources[(i + 7) % 500]));
    });
  });

  it('gives no other number of the run a fictional one a record already holds', () => {
    const fields = [field('Phone', 'phone', 40)];
    const [{ Phone: drawn }] = neutralized(new ContactPointNeutralizer('salt'), fields, [
      { Phone: '0612345678' },
    ]);

    // The same key: that number would draw the one a record already holds.
    const rows = neutralized(new ContactPointNeutralizer('salt'), fields, [
      { Phone: drawn },
      { Phone: '0612345678' },
    ]);

    expect(rows[0]['Phone']).toBe(drawn);
    expect(String(rows[1]['Phone'])).toMatch(FICTIONAL);
    expect(rows[1]['Phone']).not.toBe(drawn);
  });

  it('leaves a number out once every fictional number of the range is taken, and counts it', () => {
    const neutralizer = new ContactPointNeutralizer('salt');
    const sources = Array.from({ length: 10_001 }, (_, i) => `07${String(i).padStart(8, '0')}`);

    const rows = neutralized(
      neutralizer,
      [field('Phone', 'phone', 40), field('SMS_Number__c', 'string', 40)],
      [...sources.map((Phone) => ({ Phone })), { SMS_Number__c: 'Rappeler au 06 98 76 54 32' }],
    );

    expect(new Set(rows.slice(0, 10_000).map((row) => row['Phone'])).size).toBe(10_000);
    // Left out, the field goes in empty, and a text holding such a number too.
    expect(rows[10_000]).toEqual({});
    expect(rows[10_001]).toEqual({});
    const report = neutralizer.report();
    expect(report.numbersExhausted).toBe(2);
    expect(report.values).toBe(10_002);
  });

  it('leaves a phone value with no digit, and a number already in the fictional range', () => {
    const neutralizer = new ContactPointNeutralizer('salt');
    const rows = neutralized(
      neutralizer,
      [field('Phone', 'phone', 40)],
      [{ Phone: 'N/A' }, { Phone: '+33 6 39 98 12 34' }, { Phone: '06 39 98 12 34' }],
    );

    expect(rows).toEqual([
      { Phone: 'N/A' },
      { Phone: '+33 6 39 98 12 34' },
      { Phone: '06 39 98 12 34' },
    ]);
    expect(neutralizer.report().values).toBe(0);
  });

  it('writes the national form of the fictional number where the field cannot hold its country code', () => {
    const [row] = neutralized(
      new ContactPointNeutralizer('salt'),
      [field('SMS_Number__c', 'string', 10)],
      [{ SMS_Number__c: '0612345678' }],
    );

    expect(String(row['SMS_Number__c'])).toMatch(/^063998\d{4}$/);
  });

  it('leaves a value out when no form of it fits the field, and counts it', () => {
    const neutralizer = new ContactPointNeutralizer('salt');
    const [row] = neutralized(
      neutralizer,
      [field('Tel__c', 'string', 8)],
      [{ Tel__c: '06123456', LastName: 'Doe' }],
    );

    expect(row).toEqual({ LastName: 'Doe' });
    expect(neutralizer.report().values).toBe(1);
  });

  it('puts every address of a text named for email addresses under .invalid, and leaves the rest of it', () => {
    const rows = neutralized(
      new ContactPointNeutralizer('salt'),
      [
        field('Notification_Email__c', 'string', 255),
        field('CC_Emails__c', 'textarea', 32768),
        field('Email_Template__c', 'string', 80),
      ],
      [
        {
          Notification_Email__c: 'jane@acme.com',
          CC_Emails__c: 'Ops <ops@acme.com>; billing@acme.co.uk, done@acme.com.invalid.',
          Email_Template__c: 'Welcome',
        },
      ],
    );

    expect(rows[0]).toEqual({
      Notification_Email__c: 'jane@acme.com.invalid',
      CC_Emails__c:
        'Ops <ops@acme.com.invalid>; billing@acme.co.uk.invalid, done@acme.com.invalid.',
      Email_Template__c: 'Welcome',
    });
  });

  it('gives each address of a text short ones of their own when the field cannot hold the suffixes', () => {
    const [row] = neutralized(
      new ContactPointNeutralizer('salt'),
      [field('Backup_Email__c', 'string', 30)],
      [{ Backup_Email__c: 'jane.doe@acme-group.com' }],
    );

    expect(String(row['Backup_Email__c'])).toMatch(/^user-[0-9a-f]{8}@example\.invalid$/);
  });

  it('replaces every number in a text named for phone numbers, and leaves the rest of it', () => {
    const rows = neutralized(
      new ContactPointNeutralizer('salt'),
      [
        field('SMS_Number__c', 'string', 40),
        field('Phone_Notes__c', 'textarea', 255),
        field('Phone_Extension__c', 'string', 10),
      ],
      [
        {
          SMS_Number__c: '+33 (0)6 12 34 56 78',
          Phone_Notes__c: 'Rappeler au 06 12 34 56 78 ou au 07 98 76 54 32 après 17h',
          Phone_Extension__c: '1234',
        },
      ],
    );

    expect(String(rows[0]['SMS_Number__c'])).toMatch(FICTIONAL);
    expect(String(rows[0]['Phone_Notes__c'])).toMatch(
      /^Rappeler au \+3363998\d{4} ou au \+3363998\d{4} après 17h$/,
    );
    // Four digits reach no one.
    expect(rows[0]['Phone_Extension__c']).toBe('1234');
  });

  it('never changes a checkbox or a picklist named like a contact point', () => {
    const neutralizer = new ContactPointNeutralizer('salt');

    expect(
      neutralizer.forObject('Contact', [
        field('Email_Opt_Out__c', 'boolean'),
        field('Phone_Type__c', 'picklist'),
      ]),
    ).toBeUndefined();
  });

  it('neutralizes a renamed field under the name the row holds it by, and counts it so', () => {
    const neutralizer = new ContactPointNeutralizer('salt');
    const [row] = neutralized(
      neutralizer,
      [field('Email__c', 'email', 80)],
      [{ Email_Address__c: 'jane@acme.com' }],
      { Email__c: 'Email_Address__c' },
    );

    expect(row).toEqual({ Email_Address__c: 'jane@acme.com.invalid' });
    expect(neutralizer.report().fields).toEqual([
      { objectApiName: 'Contact', field: 'Email_Address__c', kind: 'email', values: 1 },
    ]);
  });

  it('counts the values neutralized per object and field, objects in the order it met them', () => {
    const neutralizer = new ContactPointNeutralizer('salt');
    neutralized(
      neutralizer,
      [field('Email', 'email', 80), field('Phone', 'phone', 40)],
      [
        { Email: 'a@acme.com', Phone: '0612345678' },
        { Email: 'b@acme.com', Phone: null },
      ],
    );
    neutralized(
      neutralizer,
      [field('Phone', 'phone', 40)],
      [{ Phone: '0102030405' }],
      {},
      'Account',
    );

    expect(neutralizer.report()).toEqual({
      neutralized: true,
      fields: [
        { objectApiName: 'Contact', field: 'Email', kind: 'email', values: 2 },
        { objectApiName: 'Contact', field: 'Phone', kind: 'phone', values: 1 },
        { objectApiName: 'Account', field: 'Phone', kind: 'phone', values: 1 },
      ],
      values: 4,
    });
  });
});
