import { describe, it, expect } from 'vitest';
import {
  carriesRecordType,
  defaultRecordTypeOf,
  findUnavailableRecordTypes,
  parseRecordTypeInfos,
  parseRecordTypeCounts,
  recordTypeBlockedMessage,
  recordTypeCountSoql,
  recordTypeFallbackNote,
  unavailableRecordTypeUses,
} from './recordTypeAvailability.js';

/** Fake record type ids, checksums included. */
const CUSTOMER = '012Fk00000RtAbCIAV';
const PARTNER = '012Fk00000RtDeFIAV';
const LEGACY = '012Fk00000RtGhIIAV';
const MASTER = '012000000000000AAA';

/** `recordTypeInfos` of an Account describe, as the org returns it to a user without Partner. */
const ACCOUNT_RECORD_TYPE_INFOS = [
  {
    active: true,
    available: true,
    defaultRecordTypeMapping: true,
    developerName: 'Customer_Account',
    master: false,
    name: 'Customer Account',
    recordTypeId: CUSTOMER,
    urls: { layout: `/services/data/v60.0/sobjects/Account/describe/layouts/${CUSTOMER}` },
  },
  {
    active: true,
    available: false,
    defaultRecordTypeMapping: false,
    developerName: 'Partner_Account',
    master: false,
    name: 'Partner Account',
    recordTypeId: PARTNER,
    urls: { layout: `/services/data/v60.0/sobjects/Account/describe/layouts/${PARTNER}` },
  },
  {
    active: false,
    available: false,
    defaultRecordTypeMapping: false,
    developerName: 'Legacy_Account',
    master: false,
    name: 'Legacy Account',
    recordTypeId: LEGACY,
    urls: { layout: `/services/data/v60.0/sobjects/Account/describe/layouts/${LEGACY}` },
  },
  {
    active: true,
    available: false,
    defaultRecordTypeMapping: false,
    developerName: 'Master',
    master: true,
    name: 'Master',
    recordTypeId: MASTER,
    urls: { layout: `/services/data/v60.0/sobjects/Account/describe/layouts/${MASTER}` },
  },
];

describe('parseRecordTypeInfos', () => {
  it('reads availability, activity and the default for the running user', () => {
    const infos = parseRecordTypeInfos(ACCOUNT_RECORD_TYPE_INFOS);

    expect(infos.map((i) => [i.developerName, i.available, i.active, i.master])).toEqual([
      ['Customer_Account', true, true, false],
      ['Partner_Account', false, true, false],
      ['Legacy_Account', false, false, false],
      ['Master', false, true, true],
    ]);
    expect(defaultRecordTypeOf(infos)?.developerName).toBe('Customer_Account');
  });

  it('leaves out an entry of the wrong shape and reads anything but a list as none', () => {
    expect(
      parseRecordTypeInfos([{ recordTypeId: 42, available: true }, ACCOUNT_RECORD_TYPE_INFOS[0]]),
    ).toHaveLength(1);
    expect(parseRecordTypeInfos(undefined)).toEqual([]);
    expect(parseRecordTypeInfos({ recordTypeId: CUSTOMER })).toEqual([]);
  });

  it('falls back to the label on an API version that leaves out the API name and the activity', () => {
    const [info] = parseRecordTypeInfos([
      {
        available: false,
        defaultRecordTypeMapping: false,
        master: false,
        name: 'Partner',
        recordTypeId: PARTNER,
      },
    ]);

    expect(info.developerName).toBe('Partner');
    expect(info.active).toBe(true);
  });
});

describe('findUnavailableRecordTypes', () => {
  const infos = parseRecordTypeInfos(ACCOUNT_RECORD_TYPE_INFOS);

  it('counts the records of each record type the running user cannot use', () => {
    const records = [
      { Name: 'A', RecordTypeId: PARTNER },
      { Name: 'B', RecordTypeId: CUSTOMER },
      { Name: 'C', RecordTypeId: PARTNER },
      { Name: 'D', RecordTypeId: LEGACY },
    ];

    expect(findUnavailableRecordTypes('Account', records, infos)).toEqual([
      {
        objectApiName: 'Account',
        recordTypeId: LEGACY,
        developerName: 'Legacy_Account',
        name: 'Legacy Account',
        inactive: true,
        recordCount: 1,
      },
      {
        objectApiName: 'Account',
        recordTypeId: PARTNER,
        developerName: 'Partner_Account',
        name: 'Partner Account',
        inactive: false,
        recordCount: 2,
      },
    ]);
  });

  it('matches a 15-character RecordTypeId against the 18-character one of the describe', () => {
    const uses = findUnavailableRecordTypes(
      'Account',
      [{ RecordTypeId: PARTNER.slice(0, 15) }],
      infos,
    );

    expect(uses.map((u) => u.developerName)).toEqual(['Partner_Account']);
  });

  it('holds back nothing for records with no record type, the master one, or one the target does not know', () => {
    const records = [
      { Name: 'No type' },
      { Name: 'Null type', RecordTypeId: null },
      { Name: 'Master', RecordTypeId: MASTER },
      { Name: 'Unknown', RecordTypeId: '012Fk00000ZzZzZIAV' },
    ];

    expect(findUnavailableRecordTypes('Account', records, infos)).toEqual([]);
    expect(findUnavailableRecordTypes('Account', [{ RecordTypeId: PARTNER }], [])).toEqual([]);
  });

  it('tells which records carry a held-back record type', () => {
    const uses = findUnavailableRecordTypes('Account', [{ RecordTypeId: PARTNER }], infos);

    expect(carriesRecordType({ RecordTypeId: PARTNER.slice(0, 15) }, uses)).toBe(true);
    expect(carriesRecordType({ RecordTypeId: CUSTOMER }, uses)).toBe(false);
    expect(carriesRecordType({}, uses)).toBe(false);
  });
});

describe('messages', () => {
  const [legacy, partner] = findUnavailableRecordTypes(
    'Account',
    [{ RecordTypeId: PARTNER }, { RecordTypeId: PARTNER }, { RecordTypeId: LEGACY }],
    parseRecordTypeInfos(ACCOUNT_RECORD_TYPE_INFOS),
  );

  it('names the object, the record type, the count and the fix when the user lacks access', () => {
    expect(recordTypeBlockedMessage(partner)).toBe(
      'RECORD_TYPE_UNAVAILABLE: 2 Account records use record type Partner_Account (Partner Account), ' +
        'which the running user cannot use in the target org. Give the running user access to ' +
        'record type Partner_Account on Account, or map it to one they have.',
    );
  });

  it('says to activate a record type that is inactive rather than to grant it', () => {
    expect(recordTypeBlockedMessage(legacy)).toBe(
      'RECORD_TYPE_UNAVAILABLE: 1 Account record uses record type Legacy_Account (Legacy Account), ' +
        'which is inactive in the target org. Activate record type Legacy_Account on Account in ' +
        'the target org, or map it to an active one the running user has.',
    );
  });

  it('says which default the records took instead, and how to keep the original', () => {
    const fallback = defaultRecordTypeOf(parseRecordTypeInfos(ACCOUNT_RECORD_TYPE_INFOS));

    expect(recordTypeFallbackNote(partner, fallback)).toBe(
      '2 Account records written without record type Partner_Account (Partner Account), which ' +
        "the running user cannot use in the target org: a new record took the running user's " +
        'default record type (Customer_Account), an existing one kept its own. Give the running ' +
        'user access to record type Partner_Account on Account to keep it.',
    );
    expect(recordTypeFallbackNote(legacy, undefined)).toBe(
      '1 Account record written without record type Legacy_Account (Legacy Account), which is ' +
        "inactive in the target org: a new record took the running user's default record type, " +
        'an existing one kept its own. Activate record type Legacy_Account on Account in the ' +
        'target org to keep it.',
    );
  });
});

describe('record type counts', () => {
  it('asks the count of records per record type of one object', () => {
    expect(recordTypeCountSoql('Account')).toBe(
      'SELECT RecordTypeId, COUNT(Id) n FROM Account GROUP BY RecordTypeId',
    );
  });

  it('reads the aggregate rows, leaving out records with no record type and rows of the wrong shape', () => {
    const counts = parseRecordTypeCounts([
      { attributes: { type: 'AggregateResult' }, RecordTypeId: PARTNER, n: 40 },
      { attributes: { type: 'AggregateResult' }, RecordTypeId: null, n: 7 },
      { attributes: { type: 'AggregateResult' }, RecordTypeId: CUSTOMER, n: 'many' },
    ]);

    expect([...counts]).toEqual([[PARTNER, 40]]);
    expect(parseRecordTypeCounts(undefined).size).toBe(0);
  });
});

describe('unavailableRecordTypeUses', () => {
  it('reads the same verdict from a count per record type as from the records', () => {
    const infos = parseRecordTypeInfos(ACCOUNT_RECORD_TYPE_INFOS);
    const counts = new Map([
      [PARTNER.slice(0, 15), 40],
      [CUSTOMER, 12],
      [MASTER, 3],
    ]);

    expect(unavailableRecordTypeUses('Account', counts, infos)).toEqual([
      {
        objectApiName: 'Account',
        recordTypeId: PARTNER,
        developerName: 'Partner_Account',
        name: 'Partner Account',
        inactive: false,
        recordCount: 40,
      },
    ]);
  });
});
