import { describe, it, expect, vi } from 'vitest';
import { checkForgeRootQuery, readForgeRootQuery } from './forgeRootQuery.js';
import type { ForgeDescribedObject, ForgeRootCheckDeps } from './forgeRootQuery.js';

describe('readForgeRootQuery', () => {
  it('reads the object after FROM and the fields the SELECT list and the conditions name', () => {
    expect(
      readForgeRootQuery(
        "SELECT Id, Name, Industry FROM Account WHERE Industry = 'Energy' AND AnnualRevenue > 100",
      ),
    ).toEqual({ objectApiName: 'Account', fieldRefs: ['Id', 'Name', 'Industry', 'AnnualRevenue'] });
  });

  it('takes the alias and the object name off the paths that start with them', () => {
    expect(
      readForgeRootQuery('SELECT c.Id, Contact.LastName FROM Contact c WHERE c.Email != null'),
    ).toEqual({ objectApiName: 'Contact', fieldRefs: ['Id', 'LastName', 'Email'] });
  });

  it('keeps a path that starts with a relationship', () => {
    expect(
      readForgeRootQuery(
        "SELECT Id, Account.Name FROM Contact WHERE Account.Owner.IsActive = true AND Account.Name LIKE 'A%'",
      )?.fieldRefs,
    ).toEqual(['Id', 'Account.Name', 'Account.Owner.IsActive']);
  });

  it('reads no field of a subquery, in the SELECT list or in a semi-join', () => {
    expect(
      readForgeRootQuery(
        'SELECT Id, (SELECT LastName FROM Contacts) FROM Account WHERE Id IN ' +
          "(SELECT AccountId FROM Opportunity WHERE CALENDAR_YEAR(CloseDate) = 2024 AND StageName = 'Won')",
      ),
    ).toEqual({ objectApiName: 'Account', fieldRefs: ['Id'] });
  });

  it('reads nothing out of a quoted value', () => {
    expect(
      readForgeRootQuery("SELECT Id FROM Account WHERE Name = 'x FROM Contact WHERE Email = y'"),
    ).toEqual({ objectApiName: 'Account', fieldRefs: ['Id', 'Name'] });
  });

  it('reads the one field a function is given, and leaves nested calls to the org', () => {
    expect(
      readForgeRootQuery(
        'SELECT COUNT(Id), toLabel(Industry), FORMAT(convertCurrency(AnnualRevenue)), COUNT() FROM Account',
      )?.fieldRefs,
    ).toEqual(['Id', 'Industry']);
  });

  it('reads the left-hand side of each condition and none of the values', () => {
    expect(
      readForgeRootQuery(
        'SELECT Id FROM Lead WHERE CreatedDate = LAST_N_DAYS:30 AND IsDeleted = false ' +
          "AND Status IN ('Open', 'New') AND Rating NOT IN ('Cold') AND Interests__c INCLUDES ('a') " +
          'AND NOT Company = null ORDER BY LastName LIMIT 10',
      )?.fieldRefs,
    ).toEqual(['Id', 'CreatedDate', 'IsDeleted', 'Status', 'Rating', 'Interests__c', 'Company']);
  });

  it('steps over a TYPEOF block', () => {
    expect(
      readForgeRootQuery(
        'SELECT Id, TYPEOF What WHEN Account THEN Phone, Name ELSE Name END, Subject FROM Task',
      )?.fieldRefs,
    ).toEqual(['Id', 'Subject']);
  });

  it('counts each field once, whatever its case', () => {
    expect(
      readForgeRootQuery("SELECT Name, name FROM Account WHERE NAME = 'x'")?.fieldRefs,
    ).toEqual(['Name']);
  });

  it('reads nothing when there is no object after a top-level FROM', () => {
    expect(readForgeRootQuery('Accounts in the energy industry')).toBeNull();
    expect(readForgeRootQuery('SELECT Id, Name')).toBeNull();
    expect(readForgeRootQuery('SELECT Id FROM')).toBeNull();
  });
});

const ACCOUNT: ForgeDescribedObject = {
  name: 'Account',
  label: 'Account',
  fields: [
    { name: 'Id' },
    { name: 'Name' },
    { name: 'Industry' },
    { name: 'OwnerId', relationshipName: 'Owner' },
    { name: 'ParentId', relationshipName: 'Parent' },
  ],
};

/** An org holding Account and Contact, where Account describes as above. */
function org(overrides: Partial<ForgeRootCheckDeps> = {}) {
  const deps = {
    catalog: [
      { name: 'Account', label: 'Account' },
      { name: 'Contact', label: 'Contact' },
    ],
    describe: vi.fn(async (_name: string) => ACCOUNT),
    explain: vi.fn(async (_soql: string) => ({ plans: [] })),
    ...overrides,
  };
  return deps;
}

describe('checkForgeRootQuery', () => {
  it('passes a query whose object, fields and relationships exist and the org can plan', async () => {
    const deps = org();
    const query = "SELECT Id, Name, Owner.Name FROM Account WHERE Industry = 'Energy'";

    const check = await checkForgeRootQuery(query, deps);

    expect(check).toEqual({
      rootObject: 'Account',
      rootLabel: 'Account',
      fieldsChecked: 4,
      problems: [],
    });
    expect(deps.describe).toHaveBeenCalledWith('Account');
    // The org plans the query exactly as it will be run.
    expect(deps.explain).toHaveBeenCalledWith(query);
  });

  it('names the object the way the org does, whatever case the query used', async () => {
    const check = await checkForgeRootQuery('select NAME from account', org());

    expect(check.rootObject).toBe('Account');
    expect(check.problems).toEqual([]);
  });

  it('says there is no object, and asks the org nothing, when FROM names none', async () => {
    const deps = org();

    const check = await checkForgeRootQuery('the biggest accounts', deps);

    expect(check.problems).toEqual([{ kind: 'no-from' }]);
    expect(deps.describe).not.toHaveBeenCalled();
    expect(deps.explain).not.toHaveBeenCalled();
  });

  it('refuses an object the org does not let this user query', async () => {
    const deps = org();

    const check = await checkForgeRootQuery('SELECT Id FROM Invoice__c', deps);

    expect(check.problems).toEqual([{ kind: 'object-missing', object: 'Invoice__c' }]);
    expect(deps.describe).not.toHaveBeenCalled();
  });

  it('says what the org answered when it will not describe the object', async () => {
    const deps = org({
      describe: vi.fn(async () => {
        throw Object.assign(new Error('The requested resource does not exist'), {
          errorCode: 'NOT_FOUND',
        });
      }),
    });

    const check = await checkForgeRootQuery('SELECT Id FROM Contact', deps);

    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]).toMatchObject({ kind: 'describe-failed', object: 'Contact' });
    expect(check.problems[0]).toHaveProperty('detail', expect.stringContaining('does not exist'));
    expect(deps.explain).not.toHaveBeenCalled();
  });

  it('names each field the object does not have, and then asks the org nothing', async () => {
    const deps = org();

    const check = await checkForgeRootQuery(
      'SELECT Id, Revenue__c FROM Account WHERE Tier__c = 1',
      deps,
    );

    expect(check.problems).toEqual([
      { kind: 'field-missing', object: 'Account', field: 'Revenue__c' },
      { kind: 'field-missing', object: 'Account', field: 'Tier__c' },
    ]);
    expect(deps.explain).not.toHaveBeenCalled();
  });

  it('names a relationship the object does not have once, however many paths use it', async () => {
    const check = await checkForgeRootQuery(
      "SELECT Id, Region.Name FROM Account WHERE Region.Code__c = 'EU'",
      org(),
    );

    expect(check.problems).toEqual([
      { kind: 'relationship-missing', object: 'Account', relationship: 'Region' },
    ]);
  });

  it("carries the org's own words when its parser refuses the query", async () => {
    const deps = org({
      explain: vi.fn(async () => {
        throw Object.assign(new Error("unexpected token: 'BY'"), { errorCode: 'MALFORMED_QUERY' });
      }),
    });

    const check = await checkForgeRootQuery('SELECT Id FROM Account ORDER BY BY', deps);

    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]).toMatchObject({ kind: 'org-refused' });
    expect(check.problems[0]).toHaveProperty('detail', expect.stringContaining('MALFORMED_QUERY'));
    expect(check.problems[0]).toHaveProperty(
      'detail',
      expect.stringContaining("unexpected token: 'BY'"),
    );
  });
});
