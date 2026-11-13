import { describe, expect, it } from 'vitest';
import { EmptyFixtureOrg, salesOrg } from './emptyFixtureOrg';

describe('EmptyFixtureOrg', () => {
  it('reads a path of lookups through their relationship names', async () => {
    const org = salesOrg();

    await expect(
      org.count('SELECT COUNT() FROM QuoteLineItem WHERE Quote.Opportunity.AccountId != null'),
    ).resolves.toBe(1);
    await expect(
      org.count("SELECT COUNT() FROM Opportunity WHERE Account.Name = 'Second'"),
    ).resolves.toBe(1);
  });

  it('refuses a relationship the object does not have and a field it does not list, as the org does', async () => {
    const org = salesOrg();

    await expect(org.count('SELECT COUNT() FROM Contact WHERE Nothing.Id != null')).rejects.toThrow(
      /^INVALID_FIELD: Didn't understand relationship 'Nothing'/,
    );
    await expect(org.count('SELECT COUNT() FROM Contact WHERE Hidden__c != null')).rejects.toThrow(
      "INVALID_FIELD: No such column 'Hidden__c' on entity 'Contact'",
    );
    await expect(org.count('SELECT COUNT() FROM Nowhere__c')).rejects.toThrow(/^INVALID_TYPE/);
  });

  it('reads a lookup to several objects by the type, the id and the name of what it names, and nothing past them', async () => {
    const org = salesOrg();

    await expect(org.count("SELECT COUNT() FROM Task WHERE What.Type = 'Account'")).resolves.toBe(
      1,
    );
    await expect(org.count("SELECT COUNT() FROM Event WHERE What.Name = 'Second'")).resolves.toBe(
      1,
    );
    await expect(
      org.count('SELECT COUNT() FROM Task WHERE What.AccountId != null'),
    ).rejects.toThrow("INVALID_FIELD: No such column 'AccountId' on entity 'Name'");
  });

  it('leaves deleted rows and archived activities out of a query, and reads both through queryAll', async () => {
    const org = salesOrg();

    await expect(org.count('SELECT COUNT() FROM Task')).resolves.toBe(4);
    await expect(org.countAll('SELECT COUNT() FROM Task')).resolves.toBe(6);
    await expect(org.countAll('SELECT COUNT() FROM Task WHERE IsDeleted = false')).resolves.toBe(5);
    expect(org.sent.map(({ all }) => all)).toEqual([false, true, true]);
  });

  it('reads a subquery as what it selects, two in a statement at most and never beside an OR', async () => {
    const org = salesOrg();

    // Two accounts named by a case, one of them with its contact's case too.
    await expect(
      org.count('SELECT COUNT() FROM Account WHERE Id IN (SELECT AccountId FROM Case)'),
    ).resolves.toBe(2);
    await expect(
      org.count(
        'SELECT COUNT() FROM Account WHERE (Id IN (SELECT AccountId FROM Case WHERE ContactId != null)) ' +
          'AND (Id IN (SELECT AccountId FROM Contact))',
      ),
    ).resolves.toBe(1);
    await expect(
      org.count(
        'SELECT COUNT() FROM Account WHERE (Id IN (SELECT AccountId FROM Case)) OR (Name = null)',
      ),
    ).rejects.toThrow(/^MALFORMED_QUERY: semi join sub-selects are not allowed with the 'OR'/);
    await expect(
      org.count(
        'SELECT COUNT() FROM Account WHERE (Id IN (SELECT AccountId FROM Case)) AND ' +
          '(Id IN (SELECT AccountId FROM Contact)) AND (Id IN (SELECT AccountId FROM Order))',
      ),
    ).rejects.toThrow(/^MALFORMED_QUERY: maximum of 2 semi join sub-selects/);
  });

  it('reads a checkbox left unset as false, never as empty', async () => {
    await expect(
      salesOrg().count('SELECT COUNT() FROM Pricebook2 WHERE IsStandard = false'),
    ).resolves.toBe(1);
  });

  it('answers a refusal it was given, in its words, for the object named', async () => {
    const org = salesOrg();
    org.refusals.set('Lead', 'QUERY_TIMEOUT: Your query request was running for too long.');

    await expect(org.count('SELECT COUNT() FROM Lead')).rejects.toThrow(/^QUERY_TIMEOUT/);
    await expect(org.count('SELECT COUNT() FROM Case')).resolves.toBe(3);
  });

  it('describes an object with its lookups’ relationship names and its children as flagged, and refuses one it does not have or hides', async () => {
    const org = salesOrg();
    org.hidden.add('Lead');

    const described = (await org.describe('Case')) as {
      fields: Array<{ name: string; relationshipName?: string }>;
      childRelationships: Array<{ childSObject: string; cascadeDelete: boolean }>;
    };

    expect(described.fields).toContainEqual(
      expect.objectContaining({ name: 'AccountId', relationshipName: 'Account' }),
    );
    expect(described.childRelationships).toContainEqual(
      expect.objectContaining({ childSObject: 'CaseComment', cascadeDelete: true }),
    );
    await expect(org.describe('Lead')).rejects.toThrow(/^NOT_FOUND/);
    await expect(org.describe('Nowhere__c')).rejects.toThrow(/^NOT_FOUND/);
  });

  it('describes an object without a recycle bin with no IsDeleted, and lists every object in its global describe', async () => {
    const org = new EmptyFixtureOrg([
      { name: 'Kept__c' },
      { name: 'Gone__c', noRecycleBin: true, global: { deletable: false } },
    ]);

    const gone = (await org.describe('Gone__c')) as {
      fields: Array<{ name: string }>;
      deletable: boolean;
    };

    expect(gone.fields.map((field) => field.name)).toEqual(['Id']);
    expect(gone.deletable).toBe(false);
    expect(org.global().map((object) => [object.name, object.deletable])).toEqual([
      ['Kept__c', true],
      ['Gone__c', false],
    ]);
  });
});
