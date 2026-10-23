import { describe, expect, it } from 'vitest';
import { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { DeterministicPseudonymizer } from './DeterministicPseudonymizer.js';
import { FrozenDatasetAnonymizer } from './FrozenDatasetAnonymizer.js';
import { NonReidentificationControl } from './NonReidentificationControl.js';
import {
  keptWithoutARule,
  parsePseudonymRules,
  requiredFieldsLeftEmpty,
  resolveGenerator,
  RulesFileError,
  serializePseudonymRules,
  withFieldsCleared,
  withSchemaDefaults,
  type RuleSchemaField,
} from './rulesFile.js';
import { to18 } from '../../core/common/salesforceId.js';
import type { ExtractedDataset } from './types.js';

describe('parsePseudonymRules', () => {
  it('parses a valid versioned rules file', () => {
    const file = parsePseudonymRules({
      rulesVersion: '1.2.0',
      rules: {
        'Account.Name': { generator: 'companyName' },
        'Account.Industry': { generator: 'keep', approved: true, comment: 'reviewed 2026-08' },
      },
    });
    expect(file.rulesVersion).toBe('1.2.0');
    expect(file.rules['Account.Name'].generator).toBe('companyName');
    expect(file.rules['Account.Industry'].approved).toBe(true);
  });

  it('rejects keep without explicit human approval', () => {
    expect(() =>
      parsePseudonymRules({
        rulesVersion: '1.0.0',
        rules: { 'Account.Industry': { generator: 'keep' } },
      }),
    ).toThrow(/approved/);
    expect(() =>
      parsePseudonymRules({
        rulesVersion: '1.0.0',
        rules: { 'Account.Industry': { generator: 'keep', approved: false } },
      }),
    ).toThrow(RulesFileError);
  });

  it('rejects unknown generators, bad keys and missing rulesVersion', () => {
    expect(() =>
      parsePseudonymRules({
        rulesVersion: '1.0.0',
        rules: { 'Account.X': { generator: 'scramble' } },
      }),
    ).toThrow(/unknown generator/);
    expect(() =>
      parsePseudonymRules({ rulesVersion: '1.0.0', rules: { NoDot: { generator: 'clear' } } }),
    ).toThrow(RulesFileError);
    expect(() => parsePseudonymRules({ rules: { 'Account.X': { generator: 'clear' } } })).toThrow(
      /rulesVersion/,
    );
    expect(() => parsePseudonymRules(null)).toThrow(RulesFileError);
  });

  it('lists every violation at once for actionable fixes', () => {
    try {
      parsePseudonymRules({
        rulesVersion: 'nope',
        rules: {
          'Account.A': { generator: 'keep' },
          'bad key': { generator: 'clear' },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RulesFileError);
      const violations = (error as RulesFileError).violations;
      expect(violations.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('resolveGenerator', () => {
  it('defaults to clear for any field without a rule — never clear-text', () => {
    const file = parsePseudonymRules({ rulesVersion: '1.0.0', rules: {} });
    expect(resolveGenerator(file, 'Contact', 'Description')).toBe('clear');
  });

  it('returns the configured generator', () => {
    const file = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'Contact.Email': { generator: 'email' } },
    });
    expect(resolveGenerator(file, 'Contact', 'Email')).toBe('email');
  });

  it("keeps a feed item's type when no rule names it, and only that field", () => {
    // Cleared, a load cannot tell a tracked change from a post: the tracked
    // change of a real dataset went out untyped and was refused.
    const file = parsePseudonymRules({ rulesVersion: '1.0.0', rules: {} });

    expect(resolveGenerator(file, 'FeedItem', 'Type')).toBe('keep');
    expect(resolveGenerator(file, 'FeedItem', 'Body')).toBe('clear');
    expect(resolveGenerator(file, 'Task', 'Type')).toBe('clear');
  });

  it("lets a declared rule on a feed item's type win", () => {
    const file = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'FeedItem.Type': { generator: 'clear' } },
    });
    expect(resolveGenerator(file, 'FeedItem', 'Type')).toBe('clear');
  });
});

/** The detector every module reads personal fields with. */
const detector = new PIIDetector();

describe('the platform settings an empty rules file keeps', () => {
  const required = { nillable: false, createable: true, defaultedOnCreate: false };
  const schema = new Map<string, RuleSchemaField[]>([
    [
      'BusinessHours',
      [
        { name: 'Name', type: 'string', ...required },
        { name: 'TimeZoneSidKey', type: 'picklist', restrictedPicklist: true, ...required },
        { name: 'MondayStartTime', type: 'time', nillable: true },
        { name: 'MondayEndTime', type: 'time', nillable: true },
      ],
    ],
    [
      'OperatingHours',
      [
        { name: 'Name', type: 'string', ...required },
        { name: 'TimeZone', type: 'picklist', restrictedPicklist: true, ...required },
      ],
    ],
    [
      'Account',
      [
        { name: 'Name', type: 'string', ...required },
        { name: 'Type__c', type: 'picklist', restrictedPicklist: true, ...required },
        { name: 'VAT_Rate__c', type: 'picklist', restrictedPicklist: true, nillable: true },
        { name: 'Origin__c', type: 'picklist', restrictedPicklist: false, nillable: true },
        { name: 'Interests__c', type: 'multipicklist', restrictedPicklist: true, nillable: true },
        { name: 'CurrencyIsoCode', type: 'picklist', restrictedPicklist: true, ...required },
        {
          name: 'BillingStateCode',
          type: 'picklist',
          restrictedPicklist: true,
          nillable: true,
          compoundFieldName: 'BillingAddress',
        },
        { name: 'OwnerId', type: 'reference', referenceTo: ['User'], ...required },
        { name: 'Siret__c', type: 'string', ...required, createable: false },
      ],
    ],
  ]);
  const extracted: Pick<ExtractedDataset, 'objects'> = {
    objects: [
      {
        objectApiName: 'BusinessHours',
        records: [
          {
            referenceId: 'BusinessHours-000001',
            sourceId: to18('01mA00000000001'),
            fields: {
              Name: 'Agence de Lyon',
              TimeZoneSidKey: 'Europe/Paris',
              MondayStartTime: '08:00:00.000Z',
              MondayEndTime: '18:00:00.000Z',
            },
          },
        ],
      },
      {
        objectApiName: 'OperatingHours',
        records: [
          {
            referenceId: 'OperatingHours-000001',
            sourceId: to18('0OHA00000000001'),
            fields: { Name: 'Tournée de Lyon', TimeZone: 'Europe/Paris' },
          },
        ],
      },
      {
        objectApiName: 'Account',
        records: [
          {
            referenceId: 'Account-000001',
            sourceId: to18('001A00000000001'),
            fields: {
              Name: 'Jeanne Martin',
              Type__c: 'Particulier',
              VAT_Rate__c: '20',
              Origin__c: 'Salon de Lyon',
              Interests__c: 'Golf;Voile',
              CurrencyIsoCode: 'EUR',
              BillingStateCode: '69',
            },
          },
        ],
      },
    ],
  };
  const empty = parsePseudonymRules({ rulesVersion: '1.0.0', rules: {} });

  it('keeps the time zones, the week hours and restricted picklist values, and clears the names', () => {
    const rules = withSchemaDefaults(empty, schema, detector);
    const frozen = new FrozenDatasetAnonymizer().anonymize({
      extracted: {
        ...extracted,
        asOf: '2026-10-01T00:00:00Z',
        recordTypeMap: [],
        unboundedObjects: [],
        fileFields: {},
      },
      rules,
      pseudonymizer: new DeterministicPseudonymizer('settings-salt'),
      datasetVersion: '1.0.0',
    });
    const fieldsOf = (objectApiName: string) =>
      frozen.objects.find((o) => o.objectApiName === objectApiName)?.records[0].fields;

    expect(fieldsOf('BusinessHours')).toEqual({
      Name: '',
      TimeZoneSidKey: 'Europe/Paris',
      MondayStartTime: '08:00:00.000Z',
      MondayEndTime: '18:00:00.000Z',
    });
    expect(fieldsOf('OperatingHours')).toEqual({ Name: '', TimeZone: 'Europe/Paris' });
    expect(fieldsOf('Account')).toEqual({
      Name: '',
      Type__c: 'Particulier',
      VAT_Rate__c: '20',
      // Any value an API writes, several of a person's on one record, and a
      // part of where someone lives.
      Origin__c: '',
      Interests__c: '',
      CurrencyIsoCode: 'EUR',
      BillingStateCode: '',
    });
  });

  it('passes the non-reidentification control with what it keeps', () => {
    const rules = withSchemaDefaults(empty, schema, detector);
    const full: ExtractedDataset = {
      ...extracted,
      asOf: '2026-10-01T00:00:00Z',
      recordTypeMap: [],
      unboundedObjects: [],
      fileFields: {},
    };
    const frozen = new FrozenDatasetAnonymizer().anonymize({
      extracted: full,
      rules,
      pseudonymizer: new DeterministicPseudonymizer('settings-salt'),
      datasetVersion: '1.0.0',
    });

    expect(new NonReidentificationControl().run(full, frozen, rules).passed).toBe(true);
  });

  it('lets a declared rule clear a restricted picklist that says something of a person', () => {
    const declared = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'Account.Type__c': { generator: 'clear' } },
    });
    const rules = withSchemaDefaults(declared, schema, detector);

    expect(resolveGenerator(rules, 'Account', 'Type__c')).toBe('clear');
    expect(resolveGenerator(rules, 'Account', 'VAT_Rate__c')).toBe('keep');
  });

  it('keeps the settings named alike on every object without a describe', () => {
    for (const field of [
      'TimeZoneSidKey',
      'LocaleSidKey',
      'LanguageLocaleKey',
      'CurrencyIsoCode',
    ]) {
      expect(resolveGenerator(empty, 'User', field)).toBe('keep');
    }
    expect(resolveGenerator(empty, 'BusinessHours', 'SundayEndTime')).toBe('keep');
    expect(resolveGenerator(empty, 'BusinessHours', 'Name')).toBe('clear');
    expect(resolveGenerator(empty, 'Account', 'Type__c')).toBe('clear');
  });

  it('names the required fields the rules leave empty, lookups and defaulted fields aside', () => {
    expect(
      requiredFieldsLeftEmpty(extracted, withSchemaDefaults(empty, schema, detector), schema),
    ).toEqual(['Account.Name', 'BusinessHours.Name', 'OperatingHours.Name']);
  });

  it('names a required restricted picklist too, when no describe said it was restricted', () => {
    expect(requiredFieldsLeftEmpty(extracted, empty, schema)).toEqual([
      'Account.Name',
      'Account.Type__c',
      'BusinessHours.Name',
      'OperatingHours.Name',
    ]);
  });

  it('lists the fields it kept that no rule declares', () => {
    expect(keptWithoutARule(extracted, withSchemaDefaults(empty, schema, detector))).toEqual([
      'Account.CurrencyIsoCode',
      'Account.Type__c',
      'Account.VAT_Rate__c',
      'BusinessHours.MondayEndTime',
      'BusinessHours.MondayStartTime',
      'BusinessHours.TimeZoneSidKey',
      'OperatingHours.TimeZone',
    ]);
  });
});

describe('a restricted picklist that says what a person is', () => {
  const restricted = { type: 'picklist', restrictedPicklist: true, nillable: true };
  const schema = new Map<string, RuleSchemaField[]>([
    [
      'Contact',
      [
        { name: 'GenderIdentity', label: 'Gender Identity', ...restricted },
        { name: 'MaritalStatus__c', label: 'Marital Status', ...restricted },
        // A French org's label, on a custom name that says nothing.
        { name: 'Situation__c', label: 'Situation familiale', ...restricted },
      ],
    ],
    [
      'Case',
      [
        { name: 'Status', label: 'Status', ...restricted },
        { name: 'Origin', label: 'Case Origin', ...restricted },
      ],
    ],
  ]);
  const extracted: ExtractedDataset = {
    asOf: '2026-10-01T00:00:00Z',
    recordTypeMap: [],
    unboundedObjects: [],
    fileFields: {},
    objects: [
      {
        objectApiName: 'Contact',
        records: [
          {
            referenceId: 'Contact-000001',
            sourceId: to18('003A00000000001'),
            fields: {
              GenderIdentity: 'Female',
              MaritalStatus__c: 'Married',
              Situation__c: 'Veuve',
            },
          },
        ],
      },
      {
        objectApiName: 'Case',
        records: [
          {
            referenceId: 'Case-000001',
            sourceId: to18('500A00000000001'),
            fields: { Status: 'New', Origin: 'Web' },
          },
        ],
      },
    ],
  };
  const empty = parsePseudonymRules({ rulesVersion: '1.0.0', rules: {} });

  /** What the dataset holds of the first record of an object. */
  function frozenFields(rules: ReturnType<typeof withSchemaDefaults>, objectApiName: string) {
    return new FrozenDatasetAnonymizer()
      .anonymize({
        extracted,
        rules,
        pseudonymizer: new DeterministicPseudonymizer('attributes-salt'),
        datasetVersion: '1.0.0',
      })
      .objects.find((o) => o.objectApiName === objectApiName)?.records[0].fields;
  }

  it("clears a contact's gender identity and marital status, and keeps a case's status and origin", () => {
    const rules = withSchemaDefaults(empty, schema, detector);

    expect(frozenFields(rules, 'Contact')).toEqual({
      GenderIdentity: '',
      MaritalStatus__c: '',
      Situation__c: '',
    });
    expect(frozenFields(rules, 'Case')).toEqual({ Status: 'New', Origin: 'Web' });
    expect(keptWithoutARule(extracted, rules)).toEqual(['Case.Origin', 'Case.Status']);
  });

  it('passes the non-reidentification control with what it clears', () => {
    const rules = withSchemaDefaults(empty, schema, detector);
    const frozen = new FrozenDatasetAnonymizer().anonymize({
      extracted,
      rules,
      pseudonymizer: new DeterministicPseudonymizer('attributes-salt'),
      datasetVersion: '1.0.0',
    });

    expect(new NonReidentificationControl().run(extracted, frozen, rules).passed).toBe(true);
  });

  it('keeps one a rule approves keeping, and lists no field it named among those kept without a rule', () => {
    const approved = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'Contact.MaritalStatus__c': { generator: 'keep', approved: true } },
    });
    const rules = withSchemaDefaults(approved, schema, detector);

    expect(frozenFields(rules, 'Contact')).toMatchObject({ MaritalStatus__c: 'Married' });
    expect(keptWithoutARule(extracted, rules)).toEqual(['Case.Origin', 'Case.Status']);
  });
});

describe("an opportunity's stage and the names of accounts of either kind", () => {
  /** What an org with person accounts and multiple currencies describes. */
  const schema = new Map<string, RuleSchemaField[]>([
    [
      'Opportunity',
      [
        // A standard picklist the platform does not restrict, which every
        // opportunity requires.
        { name: 'StageName', label: 'Stage', type: 'picklist', nillable: false, createable: true },
        { name: 'LeadSource', label: 'Lead Source', type: 'picklist', nillable: true },
        {
          name: 'Gender__c',
          label: 'Gender',
          type: 'picklist',
          nillable: false,
          createable: true,
        },
      ],
    ],
    [
      'Account',
      [
        // Required of neither kind by the describe: the platform computes a
        // person account's name, and a business account has no last name.
        { name: 'Name', label: 'Account Name', type: 'string', nillable: true, createable: true },
        { name: 'LastName', label: 'Last Name', type: 'string', nillable: true, createable: true },
        { name: 'IsPersonAccount', label: 'Is Person Account', type: 'boolean', createable: false },
      ],
    ],
  ]);
  /** A business account and a person account, as the source holds them. */
  function extracted(accounts: Array<Record<string, unknown>>): Pick<ExtractedDataset, 'objects'> {
    return {
      objects: [
        {
          objectApiName: 'Opportunity',
          records: [
            {
              referenceId: 'Opportunity-000001',
              sourceId: to18('006A00000000001'),
              fields: { StageName: 'Prospecting', LeadSource: 'Web', Gender__c: 'Female' },
            },
          ],
        },
        {
          objectApiName: 'Account',
          records: accounts.map((fields, i) => ({
            referenceId: `Account-00000${i + 1}`,
            sourceId: to18(`001A0000000000${i + 1}`),
            fields,
          })),
        },
      ],
    };
  }
  const business = { Name: 'Acme', LastName: null, IsPersonAccount: false };
  const person = { Name: 'Ada Example', LastName: 'Example', IsPersonAccount: true };
  const empty = parsePseudonymRules({ rulesVersion: '1.0.0', rules: {} });

  it('keeps a required picklist the platform does not restrict, and clears an optional one and one that says what a person is', () => {
    // Run for real, the stage of every opportunity was cleared, and the
    // extraction asked a default that would give them all the same.
    const rules = withSchemaDefaults(empty, schema, detector);

    expect(resolveGenerator(rules, 'Opportunity', 'StageName')).toBe('keep');
    expect(resolveGenerator(rules, 'Opportunity', 'LeadSource')).toBe('clear');
    expect(resolveGenerator(rules, 'Opportunity', 'Gender__c')).toBe('clear');
  });

  it("names a business account's name and a person account's last name the rules clear, which the describe does not require", () => {
    const rules = withSchemaDefaults(empty, schema, detector);

    expect(requiredFieldsLeftEmpty(extracted([business, person]), rules, schema)).toEqual([
      'Account.LastName',
      'Account.Name',
      'Opportunity.Gender__c',
    ]);
    expect(requiredFieldsLeftEmpty(extracted([business]), rules, schema)).toEqual([
      'Account.Name',
      'Opportunity.Gender__c',
    ]);
    expect(requiredFieldsLeftEmpty(extracted([person]), rules, schema)).toEqual([
      'Account.LastName',
      'Opportunity.Gender__c',
    ]);
  });

  it('names no account name a rule gives a value', () => {
    const named = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'Account.Name': { generator: 'companyName' } },
    });

    expect(
      requiredFieldsLeftEmpty(
        extracted([business]),
        withSchemaDefaults(named, schema, detector),
        schema,
      ),
    ).toEqual(['Opportunity.Gender__c']);
  });
});

describe('serializePseudonymRules', () => {
  it('round-trips with stable key ordering', () => {
    const file = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: {
        'Contact.Email': { generator: 'email' },
        'Account.Name': { generator: 'companyName' },
      },
    });
    const serialized = serializePseudonymRules(file);
    expect(serialized.indexOf('Account.Name')).toBeLessThan(serialized.indexOf('Contact.Email'));
    expect(parsePseudonymRules(JSON.parse(serialized))).toEqual(file);
  });
});

describe('withFieldsCleared', () => {
  /** A rules file as a user keeps it: a note of their own beside the rules. */
  const onDisk = {
    $comment: 'Reviewed with the data protection officer.',
    rulesVersion: '1.4.2',
    rules: {
      'Contact.LastName': { generator: 'lastName', comment: 'their own note' },
      'Case.Origin': { generator: 'keep', approved: true },
    },
  };

  it('gives each field kept without a rule a clear rule, which the next extraction applies', () => {
    const result = withFieldsCleared(onDisk, ['Case.Status', 'Contact.GenderIdentity']);

    expect(result.cleared).toEqual(['Case.Status', 'Contact.GenderIdentity']);
    expect(result.alreadyRuled).toEqual([]);
    const rules = parsePseudonymRules(result.payload);
    expect(rules.rules['Case.Status'].generator).toBe('clear');
    expect(rules.rules['Contact.GenderIdentity'].generator).toBe('clear');
    // A picklist the source restricts was kept by its schema; the rule wins.
    const kept = withSchemaDefaults(
      rules,
      new Map([['Case', [{ name: 'Status', type: 'picklist', restrictedPicklist: true }]]]),
      new PIIDetector(),
    );
    expect(resolveGenerator(kept, 'Case', 'Status')).toBe('clear');
  });

  it('keeps every other key and rule of the file, and moves its version on', () => {
    const result = withFieldsCleared(onDisk, ['Case.Status']);

    expect(result.payload.$comment).toBe('Reviewed with the data protection officer.');
    expect(result.payload.rules).toMatchObject(onDisk.rules);
    expect(result.rulesVersion).toBe('1.5.0');
    expect(result.payload.rulesVersion).toBe('1.5.0');
    // The file it was read from is left as it was.
    expect(onDisk.rulesVersion).toBe('1.4.2');
    expect(Object.keys(onDisk.rules)).toEqual(['Contact.LastName', 'Case.Origin']);
  });

  it('leaves a field the file already rules as declared, and the version with it when nothing is added', () => {
    const result = withFieldsCleared(onDisk, ['Case.Origin', 'Case.Origin']);

    expect(result.cleared).toEqual([]);
    expect(result.alreadyRuled).toEqual(['Case.Origin']);
    expect(result.rulesVersion).toBe('1.4.2');
    expect(parsePseudonymRules(result.payload).rules['Case.Origin'].generator).toBe('keep');
  });

  it('refuses a field not named Object.Field, and a file that is not a rules file', () => {
    expect(() => withFieldsCleared(onDisk, ['Status'])).toThrow(RulesFileError);
    expect(() => withFieldsCleared({ rules: {} }, ['Case.Status'])).toThrow(RulesFileError);
  });
});
