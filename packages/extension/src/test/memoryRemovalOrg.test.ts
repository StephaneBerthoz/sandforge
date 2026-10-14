import { describe, it, expect } from 'vitest';
import { MemoryRemovalOrg } from './memoryRemovalOrg';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

describe('MemoryRemovalOrg', () => {
  it('reads the rows a statement names, column by column, by either length of id', async () => {
    const org = new MemoryRemovalOrg();
    org.add('Account', { Id: fakeId('001', 1), Name: 'Acme' }, '2026-10-14T08:00:00.000Z');

    const answer = await org.query(
      `SELECT Id, LastModifiedDate FROM Account WHERE Id IN ('${fakeId('001', 1).slice(0, 15)}')`,
    );

    expect(answer.records).toEqual([
      { Id: fakeId('001', 1), LastModifiedDate: '2026-10-14T08:00:00.000Z' },
    ]);
  });

  it('refuses a statement it cannot read, rather than select nothing', async () => {
    await expect(new MemoryRemovalOrg().query('SELECT Id FROM Account')).rejects.toThrow(
      'Not a statement the fake org reads',
    );
  });

  it('deletes into its recycle bin, taking along what cascades, and refuses what it is told to', async () => {
    const org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
    });
    org.add('Account', { Id: fakeId('001', 1) });
    org.add('Account', { Id: fakeId('001', 2) });
    org.add('Contact', { Id: fakeId('003', 1), AccountId: fakeId('001', 1) });
    org.refuse.set(fakeId('001', 2), 'locked');

    const answer = await org.destroy('Account', [fakeId('001', 1), fakeId('001', 2)]);

    expect(answer).toEqual([
      { id: fakeId('001', 1), success: true, errors: [] },
      { success: false, errors: [{ statusCode: 'DELETE_FAILED', message: 'locked' }] },
    ]);
    expect(org.all('Contact')).toEqual([]);
    const bin = await org.queryDeleted(
      `SELECT Id FROM Contact WHERE Id IN ('${fakeId('003', 1)}') AND IsDeleted = true`,
    );
    expect(bin.records).toHaveLength(1);
  });
});
