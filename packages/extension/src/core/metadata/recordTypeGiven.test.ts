import { describe, it, expect } from 'vitest';

import { parseRecordTypeInfos, type RecordTypeAvailability } from './recordTypeAvailability.js';
import { predictedRecordTypeOf, recordTypeGivenOf } from './recordTypeGiven.js';

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
