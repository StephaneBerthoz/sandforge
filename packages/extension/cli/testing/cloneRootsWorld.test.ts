import { describe, expect, it } from 'vitest';
import {
  ROWS,
  SOURCE_ORG,
  TARGET_ORG,
  rootsSource,
  sentNames,
  sourceConn,
  targetConn,
  type TargetCreate,
} from './cloneRootsWorld.js';

describe('the orgs of a clone from records, in memory', () => {
  it('has a source that chooses records by a query and by ids, counting each request', async () => {
    const org = rootsSource();
    const conn = sourceConn(org);

    const energy = await conn.query<{ Id: string }>(
      "SELECT Id FROM Account WHERE (Industry = 'Energy') ORDER BY Id LIMIT 201",
    );
    expect(energy.records.map((row) => row.Id)).toEqual([ROWS.energyOne, ROWS.energyTwo]);

    const contacts = await conn.query<{ Id: string }>(
      `SELECT Id FROM Contact WHERE AccountId IN ('${ROWS.energyOne}','${ROWS.energyTwo}') ORDER BY Id`,
    );
    expect(contacts.records.map((row) => row.Id)).toEqual([
      ROWS.contactOfEnergyOne,
      ROWS.otherContactOfEnergyOne,
      ROWS.contactOfEnergyTwo,
    ]);
    expect(org.requests).toBe(2);

    // Its own Organization record, apart from the rows, and an object it does
    // not hold answered empty.
    const organization = await conn.query<{ Id: string }>(
      'SELECT Id, IsSandbox FROM Organization LIMIT 1',
    );
    expect(organization.records[0]?.Id).toBe(SOURCE_ORG);
    expect((await conn.query('SELECT Id FROM Lead')).records).toEqual([]);
  });

  it('refuses a column the describe does not list, as the org does', async () => {
    await expect(sourceConn(rootsSource()).query('SELECT Region__c FROM Account')).rejects.toThrow(
      /Region__c/,
    );
  });

  it('has a target that creates what it is sent, each record an id of its own, and is heard as it does', async () => {
    const heard: TargetCreate[] = [];
    const target = targetConn((call) => heard.push(call));

    const answers = await target.conn
      .sobject('Account')
      .create([{ Name: 'A' }, { Name: 'B' }] as never);

    expect((answers as unknown as Array<{ id: string }>).map((a) => a.id)).toEqual([
      '001T00000000000AAA',
      '001T00000000001AAA',
    ]);
    expect(heard).toEqual(target.creates);
    expect(sentNames(target.creates)).toEqual({ Account: ['A', 'B'] });
    const organization = await target.conn.query<{ Id: string }>(
      'SELECT Id, IsSandbox FROM Organization LIMIT 1',
    );
    expect(organization.records[0]?.Id).toBe(TARGET_ORG);
    expect((await target.conn.query('SELECT Id FROM Account')).records).toEqual([]);
  });
});
