import { describe, it, expect, vi } from 'vitest';
import { fitConnection, fitOrg, lookupField } from '../../test/fitOrg';
import type { LargeOrg, LargeOrgRow } from '../../test/largeOrg';
import { SchemaScanner, type AutopilotConnection, type FitRow } from './SchemaScanner.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const scanner = new SchemaScanner();

const ids = {
  account: (n: number) => `001${String(n).padStart(12, '0')}AAA`,
  contact: (n: number) => `003${String(n).padStart(12, '0')}AAA`,
  territory: (n: number) => `a01${String(n).padStart(12, '0')}AAA`,
  region: (n: number) => `a02${String(n).padStart(12, '0')}AAA`,
  licence: (n: number) => `a03${String(n).padStart(12, '0')}AAA`,
};

/** Two accounts, each in a territory of a region of its own, and a contact of each. */
function twoOfEach(): Record<string, LargeOrgRow[]> {
  return {
    Account: [
      { Id: ids.account(1), Territory__c: ids.territory(1), ParentId: null },
      { Id: ids.account(2), Territory__c: ids.territory(2), ParentId: ids.account(1) },
    ],
    Contact: [
      { Id: ids.contact(1), AccountId: ids.account(1) },
      { Id: ids.contact(2), AccountId: ids.account(2) },
    ],
    Territory__c: [
      { Id: ids.territory(1), Region__c: ids.region(1) },
      { Id: ids.territory(2), Region__c: ids.region(2) },
    ],
    Region__c: [{ Id: ids.region(1) }, { Id: ids.region(2) }],
  };
}

/** The org's connection, as a scan reads it. */
function source(org: LargeOrg) {
  const connection = fitConnection(org);
  return { ...connection, read: connection.conn as unknown as AutopilotConnection };
}

/** A scan of `selected` over an org holding `rows`. */
async function scanned(rows: Record<string, LargeOrgRow[]>, selected: string[]) {
  const org = fitOrg(rows);
  const connection = source(org);
  const scan = await scanner.scan(connection.read, connection.read, selected, false);
  connection.calls.queries.length = 0;
  connection.calls.describes.length = 0;
  return { org, connection, scan };
}

describe('readFitRows', () => {
  it('reads every lookup at an object of the plan, those between selected objects too', async () => {
    const { connection, scan } = await scanned(twoOfEach(), ['Account', 'Contact']);

    const rows = await scanner.readFitRows(connection.read, scan);

    expect(rows.get('Account')?.[1]).toEqual({
      Id: ids.account(2),
      ParentId: ids.account(1),
      Primary_Contact__c: undefined,
      Territory__c: ids.territory(2),
      IsPersonAccount: undefined,
    });
    expect(rows.get('Contact')?.map((row) => row['AccountId'])).toEqual([
      ids.account(1),
      ids.account(2),
    ]);
    expect(connection.calls.queries).toEqual([
      'SELECT Id, ParentId, Primary_Contact__c, Territory__c, IsPersonAccount FROM Account ' +
        'ORDER BY Id',
      'SELECT Id, AccountId, ReportsToId, IsPersonAccount FROM Contact ORDER BY Id',
    ]);
  });

  it('asks for no column the object does not describe', async () => {
    const { org, connection, scan } = await scanned(twoOfEach(), ['Account']);
    const account = org.objects.get('Account');
    if (account) account.fields = account.fields.filter((f) => f.name !== 'IsPersonAccount');
    const described = scan.objectDescribes.get('Account');
    if (described) {
      described.fields = described.fields.filter((f) => f.name !== 'IsPersonAccount');
    }

    await expect(scanner.readFitRows(connection.read, scan)).resolves.toBeInstanceOf(Map);
    expect(connection.calls.queries.join()).not.toContain('IsPersonAccount');
  });

  it('stops the fit on a read the source refuses: nothing is chosen from what was not read', async () => {
    const { connection, scan } = await scanned(twoOfEach(), ['Account']);
    const refused: AutopilotConnection = {
      ...connection.read,
      query: async () => {
        throw new Error('INVALID_FIELD');
      },
    };

    await expect(scanner.readFitRows(refused, scan)).rejects.toThrow('INVALID_FIELD');
  });

  it('reads a table too wide for one query in groups of columns', async () => {
    const rows = twoOfEach();
    const org = fitOrg(rows);
    // At a selected object: a scan reads no such lookup, a fit reads them all.
    const wide = Array.from({ length: 700 }, (_, i) =>
      lookupField(`Very_Long_Lookup_Field_Name_${i}__c`, ['Contact']),
    );
    org.objects.get('Account')?.fields.push(...wide);
    const connection = source(org);
    const scan = await scanner.scan(
      connection.read,
      connection.read,
      ['Account', 'Contact'],
      false,
    );
    connection.calls.queries.length = 0;

    const read = await scanner.readFitRows(connection.read, scan);

    expect(read.get('Account')).toHaveLength(2);
    expect(connection.calls.queries.length).toBeGreaterThan(1);
    expect(connection.calls.queries.every((soql) => soql.length < 15_000)).toBe(true);
  });
});

describe('walkFrom', () => {
  const kept = (scanRows: Record<string, FitRow[]>) => new Map(Object.entries(scanRows));

  it('reads the parents of the rows given, at every level, and those alone', async () => {
    const { connection, scan } = await scanned(twoOfEach(), ['Account']);
    const [, second] = (await scanner.readFitRows(connection.read, scan)).get('Account') ?? [];
    connection.calls.queries.length = 0;

    const walk = await scanner.walkFrom(connection.read, scan, kept({ Account: [second] }));

    expect(walk.added).toEqual(['Territory__c', 'Region__c']);
    expect(walk.parentIds).toEqual(
      new Map([
        ['Territory__c', [ids.territory(2)]],
        ['Region__c', [ids.region(2)]],
      ]),
    );
    expect(connection.calls.queries).toEqual([
      `SELECT Id, Region__c FROM Territory__c WHERE Id IN ('${ids.territory(2)}')`,
      `SELECT Id FROM Region__c WHERE Id IN ('${ids.region(2)}')`,
    ]);
  });

  it('describes nothing it holds, and reads none of the selected tables', async () => {
    const { connection, scan } = await scanned(twoOfEach(), ['Account']);
    const rows = await scanner.readFitRows(connection.read, scan);
    connection.calls.queries.length = 0;

    await scanner.walkFrom(connection.read, scan, rows);

    expect(connection.calls.describes).toEqual([]);
    expect(connection.calls.queries.join()).not.toContain('FROM Account');
  });

  it('takes in no object the plan did not hold, whatever bound fewer rows leave room under', async () => {
    // A bound kept the territories out of the plan, whose lookups stayed empty;
    // the plan holds a region through another of its records. These rows reach
    // none of that region's: the object bound alone has room for a territory.
    const rows = twoOfEach();
    const { connection, scan } = await scanned(rows, ['Account']);
    const narrowed = {
      ...scan,
      objectDescribes: new Map(
        [...scan.objectDescribes].filter(([name]) => name !== 'Territory__c'),
      ),
    };
    connection.calls.describes.length = 0;

    const walk = await scanner.walkFrom(
      connection.read,
      narrowed,
      kept({ Account: rows['Account'] as FitRow[] }),
    );

    expect(walk.added).toEqual([]);
    expect(walk.parentIds).toEqual(new Map());
    expect(connection.calls.describes).toEqual([]);
  });

  it('reads the person accounts among the accounts it reads by id with no count of its own', async () => {
    const { connection, scan } = await scanned(
      {
        Account: [
          { Id: ids.account(1), IsPersonAccount: true },
          { Id: ids.account(2), IsPersonAccount: false },
        ],
        Contact: [
          { Id: ids.contact(1), AccountId: ids.account(1) },
          { Id: ids.contact(2), AccountId: ids.account(2) },
        ],
      },
      ['Contact'],
    );
    const rows = await scanner.readFitRows(connection.read, scan);
    connection.calls.queries.length = 0;

    const walk = await scanner.walkFrom(connection.read, scan, rows);

    expect(walk.personAccounts).toEqual(new Map([['Account', 1]]));
    expect(connection.calls.queries.join()).not.toContain('COUNT()');
  });

  it('says what a record read by id names of a selected object, which may have been cut', async () => {
    const { connection, scan } = await scanned(
      {
        Account: [{ Id: ids.account(1) }, { Id: ids.account(2) }],
        Contact: [{ Id: ids.contact(1), Licence__c: ids.licence(1) }],
        Licence__c: [{ Id: ids.licence(1), Account__c: ids.account(2) }],
      },
      ['Account', 'Contact'],
    );
    const rows = await scanner.readFitRows(connection.read, scan);

    const walk = await scanner.walkFrom(connection.read, scan, rows);

    expect(walk.namingSelected).toEqual([
      {
        objectApiName: 'Licence__c',
        field: 'Account__c',
        required: true,
        target: 'Account',
        id: ids.account(2),
      },
    ]);
  });

  it('follows a polymorphic lookup by the prefix of its id, even to the one object of the plan it may name', async () => {
    const { connection, scan } = await scanned(
      {
        Task: [
          { Id: '00T000000000001AAA', WhatId: ids.account(1) },
          // An opportunity: not an object of the plan, whatever the lookup allows.
          { Id: '00T000000000002AAA', WhatId: '006000000000001AAA' },
        ],
        Account: [{ Id: ids.account(1) }],
      },
      ['Task'],
    );
    expect(scan.parentIds.get('Account')).toEqual([ids.account(1)]);
    const rows = await scanner.readFitRows(connection.read, scan);
    connection.calls.queries.length = 0;

    const walk = await scanner.walkFrom(connection.read, scan, rows);

    expect(walk.parentIds).toEqual(new Map([['Account', [ids.account(1)]]]));
    expect(connection.calls.queries.join()).not.toContain('006000000000001AAA');
  });
});
