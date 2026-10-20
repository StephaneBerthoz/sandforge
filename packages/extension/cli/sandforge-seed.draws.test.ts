import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SeedTemplate } from '@sandforge/shared';
import { childrenPerParent } from '@sandforge/shared';
import {
  accountKindOfRecordTypes,
  parseArgs,
  personAccountLine,
  personRecordTypeNames,
  recordTypeChoiceLine,
  recordTypeRule,
  rulesFromDescribe,
  seedOrchestrator,
  seededRandom,
  storageLine,
} from './sandforge-seed.js';
import { FakerFallback } from '../src/modules/seed/FakerFallback.js';
import { isReservedEmailDomain, isReservedPhone } from '../src/modules/seed/LocaleData.js';

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-seed.ts', ...args];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run a parse that is meant to be refused, and report the exit. */
function refuse(...args: string[]): { code: number | undefined; message: string } {
  let code: number | undefined;
  let message = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    message += chunk;
    return true;
  }) as never);
  try {
    parseArgs(argv(...args));
  } catch {
    // `process.exit` is stubbed to throw so the parse stops where it would.
  }
  return { code, message };
}

const RELATED = [
  '--target',
  'TGT',
  '--object',
  'Account:40',
  '--object',
  'Contact:1',
  '--relation',
  'Contact.AccountId=Account',
  '--between',
  '1-3',
];

describe('seeded draws', () => {
  it('gives the same numbers for the same seed, and others for another', () => {
    const draw = (seed: number) => Array.from({ length: 5 }, seededRandom(seed));

    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
    for (const value of draw(7)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('takes a seed from the command line, and refuses one that is no whole number', () => {
    expect(parseArgs(argv(...RELATED, '--seed', '1234')).seed).toBe(1234);
    expect(parseArgs(argv(...RELATED)).seed).toBeUndefined();
    expect(refuse(...RELATED, '--seed', '-1').code).toBe(2);
    expect(refuse(...RELATED, '--seed', '4294967296').message).toMatch(
      /--seed takes a whole number/,
    );
  });

  it('plans in a dry run the contacts the run with the same seed writes', async () => {
    // Drawn with Math.random, a dry run planned 38 contacts and the run wrote 40.
    const template = (): SeedTemplate => ({
      id: 'cli-draws',
      name: 'sandforge-seed',
      description: 'Headless run',
      version: 1,
      strategy: 'faker',
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 40,
          fieldRules: [
            {
              fieldApiName: 'Name',
              fieldType: 'string',
              ruleType: 'faker',
              config: { fakerMethod: 'company' },
            },
          ],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
        {
          objectApiName: 'Contact',
          recordCount: 120,
          fieldRules: [
            {
              fieldApiName: 'LastName',
              fieldType: 'string',
              ruleType: 'faker',
              config: { fakerMethod: 'lastName' },
            },
          ],
          excludedFields: [],
          insertOrder: 1,
          batchSize: 200,
        },
      ],
      relations: [
        {
          childObject: 'Contact',
          lookupField: 'AccountId',
          parentObject: 'Account',
          parents: { kind: 'generated' },
          distribution: { mode: 'range', min: 1, max: 3 },
        },
      ],
      tags: ['cli'],
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    });
    const contactsOf = async (seed: number, dry: boolean) => {
      let next = 0;
      const orchestrator = seedOrchestrator({
        seed,
        insert: async (_org, _object, records) => ({
          successIds: records.map(() =>
            dry ? `dry-${next++}` : `001000000000${String(next++).padStart(3, '0')}AAA`,
          ),
          errors: [],
        }),
        describeCreateableFields: async () => new Set(['Name', 'LastName', 'AccountId']),
        readExistingParentIds: async () => [],
      });
      const result = await orchestrator.execute(template(), 'TGT');
      return result.objectResults.find((o) => o.objectApiName === 'Contact')?.recordsCreated;
    };
    const expected = (seed: number) =>
      childrenPerParent({ mode: 'range', min: 1, max: 3 }, 40, seededRandom(seed)).reduce(
        (sum, n) => sum + n,
        0,
      );

    for (const seed of [11, 2026]) {
      expect(await contactsOf(seed, true)).toBe(expected(seed));
      expect(await contactsOf(seed, false)).toBe(expected(seed));
    }
    expect(expected(11)).not.toBe(expected(2026));
  });

  it('writes the same names and numbers for the same seed, and others for another', async () => {
    // The seed drew the children of a relation only: the names came from the
    // record's index, the same on every run whatever the seed.
    const written = async (seed: number) => {
      const sent: Array<Record<string, unknown>> = [];
      const orchestrator = seedOrchestrator({
        seed,
        insert: async (_org, _object, records) => {
          sent.push(...records);
          return { successIds: records.map((_, i) => `dry-${i}`), errors: [] };
        },
        describeCreateableFields: async () => new Set(['FirstName', 'LastName', 'Score__c']),
        readExistingParentIds: async () => [],
      });
      await orchestrator.execute(
        {
          id: 'cli-names',
          name: 'sandforge-seed',
          description: '',
          version: 1,
          strategy: 'faker',
          objects: [
            {
              objectApiName: 'Contact',
              recordCount: 20,
              fieldRules: [
                {
                  fieldApiName: 'FirstName',
                  ruleType: 'faker',
                  config: { fakerMethod: 'firstName' },
                },
                {
                  fieldApiName: 'LastName',
                  ruleType: 'faker',
                  config: { fakerMethod: 'lastName' },
                },
                {
                  fieldApiName: 'Score__c',
                  ruleType: 'random',
                  config: { minValue: 0, maxValue: 99 },
                },
              ],
              excludedFields: [],
              insertOrder: 0,
              batchSize: 200,
            },
          ],
          tags: ['cli'],
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z',
        },
        'TGT',
      );
      return sent;
    };
    expect(await written(7)).toEqual(await written(7));
    expect(await written(7)).not.toEqual(await written(8));
  });
});

describe('storage line', () => {
  it('says what the records take against what the target has left', () => {
    expect(
      storageLine({ verdict: 'fits', estimateMB: 0.58, maxMB: 5, remainingMB: 5 }, 'my-dev-org'),
    ).toBe('data storage: about 0.58 MB to write, my-dev-org has 5 MB left of 5 MB');
    expect(
      storageLine({ verdict: 'near', estimateMB: 4.2, maxMB: 5, remainingMB: 5 }, 'my-dev-org'),
    ).toBe(
      'data storage: about 4.2 MB to write, my-dev-org has 5 MB left of 5 MB: close to what it has left',
    );
    expect(
      storageLine({ verdict: 'unread', estimateMB: 1, unread: 'API_DISABLED' }, 'my-dev-org'),
    ).toBe(
      'data storage: about 1 MB to write; what my-dev-org has left could not be read (API_DISABLED)',
    );
  });
});

describe('contact points', () => {
  const field = (name: string, type: string, over: Partial<{ createable: boolean }> = {}) => ({
    name,
    type,
    createable: true,
    nillable: true,
    ...over,
  });

  it('fills the standard email and phone fields of an object, which no rule requires', () => {
    // Run into a client sandbox, every contact and account was written
    // without an email and without a phone: nothing asked for them.
    const rules = rulesFromDescribe(
      [
        field('LastName', 'string', {}),
        field('Email', 'email'),
        field('Phone', 'phone'),
        field('MobilePhone', 'phone'),
        field('Backup_Email__c', 'email'),
        field('Fax', 'phone', { createable: false }),
      ],
      'Contact',
    );

    expect(rules.map((r) => [r.fieldApiName, r.config.fakerMethod])).toEqual([
      ['Email', 'email'],
      ['Phone', 'phone'],
      ['MobilePhone', 'phone'],
    ]);
  });

  it('leaves the person fields out of an account, written as a business account', () => {
    const rules = rulesFromDescribe(
      [
        field('Name', 'string'),
        field('Phone', 'phone'),
        field('PersonEmail', 'email'),
        field('PersonMobilePhone', 'phone'),
        { ...field('LastName', 'string'), nillable: false },
      ],
      'Account',
    );

    expect(rules.map((r) => r.fieldApiName)).toEqual(['Name', 'Phone']);
  });

  it('writes an account given a person account’s record type as a person: names, email and phones, no Name', () => {
    // The org builds a person account's Name from its two names and refuses
    // one written; written as a business account, it went in as a company.
    const fields = [
      field('Name', 'string'),
      field('FirstName', 'string'),
      field('LastName', 'string'),
      field('Salutation', 'picklist'),
      field('Phone', 'phone'),
      field('PersonEmail', 'email'),
      field('PersonMobilePhone', 'phone'),
      field('Industry', 'picklist'),
    ];

    const rules = rulesFromDescribe(fields, 'Account', 'person');

    expect(rules.map((r) => [r.fieldApiName, r.config.fakerMethod])).toEqual([
      ['FirstName', 'firstName'],
      ['LastName', 'lastName'],
      ['Phone', 'phone'],
      ['PersonEmail', 'email'],
      ['PersonMobilePhone', 'phone'],
    ]);
    const [record] = new FakerFallback('en_US').generate(rules, 1);
    expect(record.Name).toBeUndefined();
    expect(typeof record.LastName).toBe('string');
    expect(isReservedEmailDomain(String(record.PersonEmail).split('@')[1])).toBe(true);
    expect(isReservedPhone(String(record.PersonMobilePhone), 'en_US')).toBe(true);
    // A business account is written as it was.
    expect(rulesFromDescribe(fields, 'Account').map((r) => r.fieldApiName)).toEqual([
      'Name',
      'Phone',
    ]);
  });

  it('draws addresses and numbers nobody holds, in the locale asked for', () => {
    const rules = rulesFromDescribe([field('Email', 'email'), field('Phone', 'phone')], 'Contact');
    for (const locale of ['en_US', 'fr_FR']) {
      const records = new FakerFallback(locale).generate(rules, 20);
      expect(records.filter((r) => r.Email && r.Phone)).toHaveLength(20);
      for (const record of records) {
        expect(isReservedEmailDomain(String(record.Email).split('@')[1])).toBe(true);
        expect(isReservedPhone(String(record.Phone), locale)).toBe(true);
      }
    }
    expect(
      parseArgs(argv('--target', 'TGT', '--object', 'Contact:2', '--locale', 'fr_FR')).locale,
    ).toBe('fr_FR');
    expect(refuse('--target', 'TGT', '--object', 'Contact:2', '--locale', 'xx_XX').code).toBe(2);
  });
});

describe('record types', () => {
  const info = (
    developerName: string,
    recordTypeId: string,
    over: Record<string, boolean> = {},
  ) => ({
    active: true,
    available: true,
    defaultRecordTypeMapping: false,
    developerName,
    master: false,
    name: developerName,
    recordTypeId,
    urls: {},
    ...over,
  });
  const INFOS = [
    info('Customer', '0120000000000C1AAA', { defaultRecordTypeMapping: true }),
    info('Partner', '0120000000000P1AAA'),
    info('Closed', '0120000000000X1AAA', { available: false }),
    info('Master', '012000000000000AAA', { master: true }),
  ];

  it('gives the records the record type named, by its API name', () => {
    expect(recordTypeRule('Account', ['Partner'], INFOS)).toEqual({
      rule: {
        fieldApiName: 'RecordTypeId',
        fieldType: 'reference',
        ruleType: 'static',
        config: { staticValue: '0120000000000P1AAA' },
      },
    });
    expect(recordTypeRule('Account', ['Customer', 'Partner'], INFOS)).toEqual({
      rule: {
        fieldApiName: 'RecordTypeId',
        fieldType: 'reference',
        ruleType: 'picklist_random',
        config: { picklistValues: ['0120000000000C1AAA', '0120000000000P1AAA'] },
      },
    });
  });

  it('refuses a record type the running user may not use, or one the object does not have', () => {
    expect(recordTypeRule('Account', ['Closed'], INFOS)).toEqual({
      refusal:
        '--record-type Account=Closed: the running user may not use record type Closed. ' +
        'Open to them: Customer, Partner.',
    });
    expect(recordTypeRule('Account', ['Nope'], INFOS)).toMatchObject({
      refusal: expect.stringMatching(/Account has no record type Nope/),
    });
  });

  it('says which record types the records could take, when they take the default', () => {
    expect(recordTypeChoiceLine('Account', INFOS)).toBe(
      '  Account: 2 record types open to you (Customer, Partner); the records take your ' +
        'default, Customer: --record-type Account=<Name> chooses',
    );
    expect(recordTypeChoiceLine('Contact', [INFOS[0], INFOS[3]])).toBeUndefined();
  });

  it('takes the record types of an object of the line', () => {
    expect(
      parseArgs(
        argv(
          '--target',
          'TGT',
          '--object',
          'Account:2',
          '--record-type',
          'Account=Customer,Partner',
        ),
      ).recordTypes,
    ).toEqual({ Account: ['Customer', 'Partner'] });
    expect(
      refuse('--target', 'TGT', '--object', 'Account:2', '--record-type', 'Case=Main').message,
    ).toMatch(/give Case with --object too/);
  });
});

describe('person accounts', () => {
  it('reads the org’s person account record types by API name, and none from an org without them', async () => {
    const query = vi.fn(async (soql: string) => ({
      records: [{ DeveloperName: 'PersonAccount' }, { DeveloperName: 'Patient' }],
      soql,
    }));
    expect([...(await personRecordTypeNames({ query }))]).toEqual(['PersonAccount', 'Patient']);
    expect(query.mock.calls[0][0]).toBe(
      "SELECT DeveloperName FROM RecordType WHERE SobjectType = 'Account' AND IsPersonType = true",
    );

    // An org without person accounts has no IsPersonType, and refuses the read.
    const refusing = {
      query: async () => {
        throw new Error("INVALID_FIELD: No such column 'IsPersonType' on entity 'RecordType'");
      },
    };
    expect((await personRecordTypeNames(refusing)).size).toBe(0);
  });

  it('writes person accounts for person record types, business accounts for the others, and refuses a mix', () => {
    const persons = new Set(['PersonAccount', 'Patient']);

    expect(accountKindOfRecordTypes(['PersonAccount'], persons)).toEqual({ kind: 'person' });
    expect(accountKindOfRecordTypes(['PersonAccount', 'Patient'], persons)).toEqual({
      kind: 'person',
    });
    expect(accountKindOfRecordTypes(['Customer'], persons)).toEqual({ kind: 'business' });
    expect(accountKindOfRecordTypes(['Customer'], new Set())).toEqual({ kind: 'business' });
    const mixed = accountKindOfRecordTypes(['PersonAccount', 'Customer'], persons);
    expect('refusal' in mixed && mixed.refusal).toBe(
      '--record-type Account: PersonAccount is a person account record type and Customer is ' +
        'not: a person account and a business account take different fields. Seed one kind in a run.',
    );
  });

  it('says the accounts are written as person accounts, and without a Name', () => {
    expect(personAccountLine(['PersonAccount'])).toBe(
      '  Account: PersonAccount is a person account record type: the accounts are written as ' +
        'person accounts, with a first and last name, the person’s email and phones, and no ' +
        'Name, which the org builds from the two names',
    );
  });
});
