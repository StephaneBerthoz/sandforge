import { describe, it, expect } from 'vitest';
import { fitConnection, fitOrg } from './fitOrg';

describe('fitOrg', () => {
  const account = { Id: '001000000000001AAA', Name: 'One', ParentId: null };

  it('refuses a read of a column the object lacks, as the org refuses it', async () => {
    const { conn } = fitConnection(fitOrg({ Account: [account] }));

    await expect(conn.query('SELECT Id, LastModifiedById FROM Account')).rejects.toMatchObject({
      errorCode: 'INVALID_FIELD',
    });
  });

  it('answers the columns the object has, and FIELDS(ALL) with the row', async () => {
    const { conn, calls } = fitConnection(fitOrg({ Account: [account] }));

    expect((await conn.query('SELECT Id, ParentId FROM Account ORDER BY Id')).records).toEqual([
      { Id: account.Id, ParentId: null },
    ]);
    expect((await conn.query('SELECT FIELDS(ALL) FROM Account LIMIT 200')).records).toEqual([
      account,
    ]);
    expect(calls.queries).toHaveLength(2);
  });
});
