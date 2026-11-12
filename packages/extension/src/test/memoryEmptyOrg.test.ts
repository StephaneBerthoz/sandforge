import { describe, expect, it } from 'vitest';

import { HARD_DELETE_NOT_ENABLED } from '../core/removal/deleteRecords.js';
import { MemoryEmptyOrg, NO_HARD_DELETE, SALES, emptySalesSpecs } from './memoryEmptyOrg.js';

describe('MemoryEmptyOrg', () => {
  it('refuses a hardDelete job as it is opened to a user without Bulk API Hard Delete, in the org’s words', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const answer = await org.bulkHardDestroy('Contact', [SALES.contactAlone]);

    expect(answer).toEqual({
      kind: 'untouched',
      reason: NO_HARD_DELETE,
      code: HARD_DELETE_NOT_ENABLED,
      requests: 1,
    });
    expect(org.live('Contact')).toContain(SALES.contactAlone);
  });

  it('lists what a hardDelete job deleted, its children taken along included, as deleted, and never brings it back', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs(), { hardDelete: true });
    // Its case refuses the account's delete while it lives.
    await org.bulkHardDestroy('Case', [SALES.caseOfAccount2]);
    await org.bulkHardDestroy('Account', [SALES.account2]);

    const read = await org.queryDeleted(
      `SELECT Id FROM Order WHERE Id = '${SALES.draftOrder}' AND IsDeleted = true`,
    );
    expect(read.records).toHaveLength(1);
    const [answer] = (await org.undelete([SALES.account2])) as Array<{
      success: boolean;
      errors: Array<{ message: string }>;
    }>;
    expect(answer.success).toBe(false);
    expect(answer.errors[0].message).toBe('Entity is not in the recycle bin');
  });

  it('counts what it holds now: a count after a delete counts what is left', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    expect(await org.count('SELECT COUNT() FROM Contact WHERE AccountId != null')).toBe(2);
    await org.destroy('Contact', [SALES.contact1]);
    expect(await org.count('SELECT COUNT() FROM Contact WHERE AccountId != null')).toBe(1);
    expect(await org.countAll('SELECT COUNT() FROM Contact WHERE IsDeleted = true')).toBe(1);
  });

  it('dates its rows a day before its clock, and answers as a sandbox unless told', async () => {
    const org = new MemoryEmptyOrg(emptySalesSpecs());
    const [row] = org.memory.all('Account');
    expect(Date.parse(String(row.CreatedDate))).toBe(org.nowMs - 86_400_000);
    const page = await org.query('SELECT Id, IsSandbox FROM Organization LIMIT 1');
    expect(page.records[0].IsSandbox).toBe(true);

    const production = new MemoryEmptyOrg([], { production: { edition: 'Enterprise Edition' } });
    const typed = await production.query('SELECT OrganizationType FROM Organization LIMIT 1');
    expect(typed.records[0].OrganizationType).toBe('Enterprise Edition');
  });
});
