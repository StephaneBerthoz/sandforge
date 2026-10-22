import { describe, it, expect } from 'vitest';
import { MEMORY_ORG_USER } from './memoryRemovalOrg';
import { MemoryRestoreOrg } from './memoryRestoreOrg';

const A1 = '001000000000001AAA';
const A2 = '001000000000002AAA';

describe('MemoryRestoreOrg', () => {
  it('makes an update, stamped to its second as the session’s user, and keeps it in order', async () => {
    const org = new MemoryRestoreOrg({}, { now: () => Date.parse('2026-10-22T20:17:26.731Z') });
    org.add(
      'Account',
      { Id: A1, Name: 'After', LastModifiedById: '005000000000002AAA' },
      '2026-10-01T00:00:00.000Z',
    );

    const answer = await org.update('Account', [{ Id: A1.slice(0, 15), Name: 'Before' }]);

    expect(answer).toEqual([{ id: A1.slice(0, 15), success: true, errors: [] }]);
    expect(org.all('Account')[0]).toMatchObject({
      Id: A1,
      Name: 'Before',
      SystemModstamp: '2026-10-22T20:17:26.000Z',
      LastModifiedDate: '2026-10-22T20:17:26.000Z',
      LastModifiedById: MEMORY_ORG_USER,
    });
    expect(org.updates).toEqual([
      { objectApiName: 'Account', records: [{ Id: A1.slice(0, 15), Name: 'Before' }] },
    ]);
    expect(org.requests).toBe(1);
  });

  it('refuses the records a test names, and answers one it does not hold as deleted', async () => {
    const org = new MemoryRestoreOrg();
    org.add('Account', { Id: A1, Name: 'After' });
    org.refuseUpdate.set(A1, { statusCode: 'ENTITY_IS_LOCKED', message: 'locked' });

    const answer = await org.update('Account', [
      { Id: A1, Name: 'Before' },
      { Id: A2, Name: 'Before' },
    ]);

    expect(answer).toEqual([
      { id: A1, success: false, errors: [{ statusCode: 'ENTITY_IS_LOCKED', message: 'locked' }] },
      {
        id: A2,
        success: false,
        errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
      },
    ]);
    expect(org.all('Account')[0]).toMatchObject({ Name: 'After' });
  });
});
