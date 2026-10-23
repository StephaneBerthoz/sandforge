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

  it('refuses a field while live records of another object name the record, naming the field, and writes it once they are gone', async () => {
    const org = new MemoryRestoreOrg();
    const opportunity = '006000000000001AAA';
    const line = '00k000000000001AAA';
    org.add('Opportunity', { Id: opportunity, Name: 'After', Pricebook2Id: '01s000000000002AAA' });
    org.add('OpportunityLineItem', { Id: line, OpportunityId: opportunity });
    org.heldByChildren.push({
      objectApiName: 'Opportunity',
      fields: ['Pricebook2Id', 'Amount'],
      childSObject: 'OpportunityLineItem',
      field: 'OpportunityId',
      statusCode: 'FIELD_INTEGRITY_EXCEPTION',
      message: 'Cannot change pricebook on opportunity with line items',
    });
    const back = { Id: opportunity, Name: 'Before', Pricebook2Id: '01s000000000001AAA' };

    const refused = await org.update('Opportunity', [{ ...back }]);
    // A field the rule does not name is written as ever.
    const named = await org.update('Opportunity', [{ Id: opportunity, Name: 'Before' }]);
    org.trash('OpportunityLineItem', line);
    const written = await org.update('Opportunity', [{ ...back }]);

    expect(refused).toEqual([
      {
        id: opportunity,
        success: false,
        errors: [
          {
            statusCode: 'FIELD_INTEGRITY_EXCEPTION',
            message: 'Cannot change pricebook on opportunity with line items',
            fields: ['Pricebook2Id'],
          },
        ],
      },
    ]);
    expect(named).toEqual([{ id: opportunity, success: true, errors: [] }]);
    expect(written).toEqual([{ id: opportunity, success: true, errors: [] }]);
    expect(org.all('Opportunity')[0]).toMatchObject({ Pricebook2Id: '01s000000000001AAA' });
  });

  it('makes records under new ids of their object’s prefix, dated now as the session’s user, refusing one a test names and one whose lookup names a record no longer live', async () => {
    const org = new MemoryRestoreOrg({}, { now: () => Date.parse('2026-10-22T20:17:26.731Z') });
    org.add('Account', { Id: A1, Name: 'Live' });
    org.add('Account', { Id: A2, Name: 'Gone' });
    org.trash('Account', A2);
    org.refuseCreate = (_objectApiName, record) =>
      record.LastName === 'Refused'
        ? { statusCode: 'DUPLICATES_DETECTED', message: 'dup' }
        : undefined;

    const answer = (await org.create('Contact', [
      { LastName: 'Made', AccountId: A1 },
      { LastName: 'Refused', AccountId: A1 },
      { LastName: 'Orphan', AccountId: A2 },
    ])) as Array<{ id?: string; success: boolean; errors: unknown[] }>;

    expect(answer.map(({ success }) => success)).toEqual([true, false, false]);
    expect(answer[1].errors).toEqual([{ statusCode: 'DUPLICATES_DETECTED', message: 'dup' }]);
    expect(answer[2].errors).toEqual([
      expect.objectContaining({ statusCode: 'INVALID_CROSS_REFERENCE_KEY', fields: ['AccountId'] }),
    ]);
    const [made] = org.all('Contact');
    expect(made).toMatchObject({
      Id: answer[0].id,
      LastName: 'Made',
      CreatedDate: '2026-10-22T20:17:26.000Z',
      SystemModstamp: '2026-10-22T20:17:26.000Z',
      LastModifiedById: MEMORY_ORG_USER,
    });
    expect(org.creates).toHaveLength(1);
    expect(org.requests).toBe(1);
  });
});
