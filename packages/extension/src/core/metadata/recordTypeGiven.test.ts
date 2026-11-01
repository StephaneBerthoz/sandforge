import { describe, it, expect } from 'vitest';

import { parseRecordTypeInfos, type RecordTypeAvailability } from './recordTypeAvailability.js';
import {
  RECORD_TYPE_READ_BACK_IDS,
  givenRecordTypeId,
  predictedRecordTypeOf,
  recordTypeGivenOf,
  recordTypeReadBackSoql,
  recordTypesReadBack,
} from './recordTypeGiven.js';

let made = 0;

/** A describe's `recordTypeInfos` entry, as the org answers it: open and not the default unless told. */
function info(
  developerName: string,
  over: Partial<
    Record<'available' | 'active' | 'master' | 'defaultRecordTypeMapping', boolean>
  > = {},
): Record<string, unknown> {
  made += 1;
  return {
    recordTypeId: `012xx0000000${String(made).padStart(3, '0')}AAA`,
    developerName,
    name: developerName.replace(/_/g, ' '),
    available: true,
    active: true,
    master: false,
    defaultRecordTypeMapping: false,
    ...over,
  };
}

/** Master, as every describe lists it last. */
const master = (over: Parameters<typeof info>[1] = {}) =>
  ({ ...info('Master', { master: true, ...over }), recordTypeId: '012000000000000AAA' }) as Record<
    string,
    unknown
  >;

const read = (...raw: Array<Record<string, unknown>>): RecordTypeAvailability[] =>
  parseRecordTypeInfos(raw);

/**
 * The scratch target's Opportunity describe for its admin, as the org
 * answered it (ids made up): Master the default, SFX_Retail opened by a
 * permission set, SFX_Hidden kept from the user, SFX_Source_Only inactive.
 * An Opportunity inserted without a type went in as SFX_Retail.
 */
const TARGET_OPPORTUNITY = read(
  info('SFX_Hidden', { available: false }),
  info('SFX_Retail'),
  info('SFX_Source_Only', { active: false }),
  master({ defaultRecordTypeMapping: true }),
);

describe('recordTypeGivenOf', () => {
  it('gives the only type open to the user when its describe names Master, as the target did', () => {
    const given = recordTypeGivenOf(TARGET_OPPORTUNITY);
    expect(given).toMatchObject({
      kind: 'given',
      basis: 'onlyOneOpen',
      info: { developerName: 'SFX_Retail' },
    });
    // Read from the default alone, the describe says Master: what was said, and was wrong.
    expect(TARGET_OPPORTUNITY.find((i) => i.defaultRecordTypeMapping)?.master).toBe(true);
    // A type kept from the user is no candidate: counted, SFX_Hidden would make two.
    expect(TARGET_OPPORTUNITY.filter((i) => !i.master && i.active)).toHaveLength(2);
  });

  it('gives the default the describe names when it is not Master: the profile’s', () => {
    const given = recordTypeGivenOf(
      read(info('Business_Account', { defaultRecordTypeMapping: true }), info('Partner'), master()),
    );
    expect(given).toMatchObject({
      kind: 'given',
      basis: 'userDefault',
      info: { developerName: 'Business_Account' },
    });
  });

  it('keeps Master when the describe names it and no other type is open to the user', () => {
    expect(
      recordTypeGivenOf(
        read(
          info('SFX_Retail', { available: false }),
          info('Retired', { active: false }),
          master({ defaultRecordTypeMapping: true }),
        ),
      ),
    ).toEqual({ kind: 'master' });
    expect(recordTypeGivenOf(read(master({ defaultRecordTypeMapping: true })))).toEqual({
      kind: 'master',
    });
  });

  it('keeps Master when the describe names it and two or more types are open, as an insert with three open got', () => {
    expect(
      recordTypeGivenOf(
        read(
          info('SFX_Hidden'),
          info('SFX_Retail'),
          info('SFX_Source_Only'),
          master({ defaultRecordTypeMapping: true }),
        ),
      ),
    ).toEqual({ kind: 'master' });
    expect(
      recordTypeGivenOf(
        read(info('SFX_Hidden'), info('SFX_Retail'), master({ defaultRecordTypeMapping: true })),
      ),
    ).toEqual({ kind: 'master' });
  });

  it('reads a default the user cannot use as none, and lets the types open decide', () => {
    expect(
      recordTypeGivenOf(
        read(
          info('Closed', { available: false, defaultRecordTypeMapping: true }),
          info('Open'),
          master(),
        ),
      ),
    ).toMatchObject({ kind: 'given', basis: 'onlyOneOpen', info: { developerName: 'Open' } });
  });

  it('has nothing to say of an object with no record type, or a describe that names no default', () => {
    expect(recordTypeGivenOf([])).toEqual({ kind: 'master' });
    expect(recordTypeGivenOf(read(info('Retail'), master()))).toMatchObject({
      kind: 'given',
      basis: 'onlyOneOpen',
    });
  });
});

describe('predictedRecordTypeOf', () => {
  it('names the type given by its DeveloperName and label, and why', () => {
    expect(predictedRecordTypeOf(recordTypeGivenOf(TARGET_OPPORTUNITY))).toEqual({
      developerName: 'SFX_Retail',
      label: 'SFX Retail',
      basis: 'onlyOneOpen',
    });
  });

  it('says nothing when the org keeps Master', () => {
    expect(predictedRecordTypeOf({ kind: 'master' })).toBeUndefined();
  });
});

/** The id of a type of the scratch target's Opportunity, by its DeveloperName. */
const idOf = (developerName: string): string =>
  TARGET_OPPORTUNITY.find((i) => i.developerName === developerName)!.recordTypeId;

describe('givenRecordTypeId', () => {
  it('gives the id of the type given, or Master’s own when the record stays on it', () => {
    expect(givenRecordTypeId(TARGET_OPPORTUNITY)).toBe(idOf('SFX_Retail'));
    expect(
      givenRecordTypeId(
        read(info('SFX_Hidden'), info('SFX_Retail'), master({ defaultRecordTypeMapping: true })),
      ),
    ).toBe('012000000000000AAA');
  });

  it('gives nothing without a describe, or one that lists no Master', () => {
    expect(givenRecordTypeId(undefined)).toBeUndefined();
    expect(givenRecordTypeId([])).toBeUndefined();
  });
});

/** A fake record id: the object's prefix, then a counter. */
const recordId = (prefix: string, n: number): string =>
  `${prefix}${String(n).padStart(12, '0')}AAA`;

/** The record types statement a read back sends, its ids taken out. */
const READ_BACK =
  /^SELECT RecordTypeId, COUNT\(Id\) n FROM (\w+) WHERE Id IN \((.*)\) GROUP BY RecordTypeId$/;

describe('the read back of the record types the target gave', () => {
  it('asks for at most 200 ids in one statement, counted by record type', () => {
    const ids = Array.from({ length: 250 }, (_, i) => recordId('006', i));

    const soql = recordTypeReadBackSoql('Opportunity', ids);

    expect(RECORD_TYPE_READ_BACK_IDS).toBe(200);
    expect(soql).toMatch(READ_BACK);
    expect([...soql.matchAll(/'([^']+)'/g)].map(([, asked]) => asked)).toEqual(ids.slice(0, 200));
  });

  it('asks for no id the target could not have answered', () => {
    const soql = recordTypeReadBackSoql('Opportunity', [recordId('006', 1), "006') OR (Id != '"]);

    expect([...soql.matchAll(/'([^']+)'/g)].map(([, asked]) => asked)).toEqual([
      recordId('006', 1),
    ]);
  });

  it('refuses an object name that is not one', () => {
    expect(() => recordTypeReadBackSoql('Opportunity WHERE', [recordId('006', 1)])).toThrow();
  });

  it('names an empty record type Master, and each other by the describe, the most held first', () => {
    const found = recordTypesReadBack(
      [
        { RecordTypeId: idOf('SFX_Retail'), n: 3 },
        { RecordTypeId: null, n: 20 },
      ],
      TARGET_OPPORTUNITY,
    );

    expect(found).toEqual({
      read: 23,
      types: [
        { developerName: 'Master', label: 'Master', rows: 20 },
        { developerName: 'SFX_Retail', label: 'SFX Retail', rows: 3 },
      ],
    });
  });

  it('names a type by its 15-character id as the org may answer it, and one the describe lacks by its id', () => {
    const unknown = '0120000000009Z9AAA';
    const found = recordTypesReadBack(
      [
        { RecordTypeId: idOf('SFX_Retail').slice(0, 15), n: 2 },
        { RecordTypeId: unknown, n: 1 },
      ],
      TARGET_OPPORTUNITY,
    );

    expect(found.types).toEqual([
      { developerName: 'SFX_Retail', label: 'SFX Retail', rows: 2 },
      { developerName: unknown, label: unknown, rows: 1 },
    ]);
  });

  it('says it could not read rows that count no records, rather than read none', () => {
    expect(recordTypesReadBack([{ RecordTypeId: idOf('SFX_Retail') }], TARGET_OPPORTUNITY)).toEqual(
      {
        read: 0,
        types: [],
        unread: 'the org answered rows that name no record type count',
      },
    );
  });
});
