import { describe, it, expect } from 'vitest';
import {
  lockedParentOrg,
  lockMessage,
  triggerLockMessage,
  type JobResults,
} from './lockedParentOrg.js';

const HUB = `001${'0'.repeat(11)}9AAA`;

/** The handle of a job the fake opens, as the executor drives it. */
interface FakeJob {
  open: () => Promise<void>;
  uploadData: (csv: string) => Promise<void>;
  close: () => Promise<void>;
  getAllResults: () => Promise<JobResults>;
}

describe('lockedParentOrg', () => {
  it('refuses over REST each row naming the held record, as the platform words it, and saves the others', async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: 1 });

    const answers = await org.connection
      .sobject('Contact')
      .create([{ LastName: 'On hub', AccountId: HUB }, { LastName: 'Alone' }]);

    expect(answers[0]).toEqual({
      success: false,
      errors: [{ statusCode: 'UNABLE_TO_LOCK_ROW', message: lockMessage(HUB), fields: [] }],
    });
    expect(answers[1].success).toBe(true);
    expect(org.written.map((record) => record.row['LastName'])).toEqual(['Alone']);
  });

  it('lets the record go after the calls it was held for, and saves the same row then', async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: 2 });
    const row = { LastName: 'On hub', AccountId: HUB };

    const first = await org.connection.sobject('Contact').create([row]);
    const second = await org.connection.sobject('Contact').create([row]);
    const third = await org.connection.sobject('Contact').create([row]);

    expect([first[0].success, second[0].success, third[0].success]).toEqual([false, false, true]);
    expect(org.written).toHaveLength(1);
    expect(org.callsUnderTheLock()).toBe(2);
  });

  it("words the refusal as a trigger's whose update met the lock, when asked", async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: 1, trigger: true });

    const [answer] = await org.connection.sobject('Contact').create([{ AccountId: HUB }]);

    expect(answer.errors[0]).toEqual({
      statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
      message: triggerLockMessage(HUB),
      fields: [],
    });
  });

  it('answers a Bulk API job as jsforce reads it: the refused rows in its failed results, with their cells', async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: 1 });
    const job = org.connection.bulk2.createJob({
      operation: 'insert',
      object: 'Contact',
    }) as FakeJob;

    await job.open();
    await job.uploadData(`"LastName","AccountId"\n"On hub","${HUB}"\n"Alone",""\n`);
    await job.close();
    const results = await job.getAllResults();

    expect(results.failedResults).toEqual([
      {
        sf__Id: '',
        sf__Error: `UNABLE_TO_LOCK_ROW:${lockMessage(HUB)}:--`,
        LastName: 'On hub',
        AccountId: HUB,
      },
    ]);
    expect(results.successfulResults).toHaveLength(1);
    expect(results.successfulResults[0]).toMatchObject({ LastName: 'Alone', sf__Created: 'true' });
    expect(org.jobs.map((sent) => sent.rows.length)).toEqual([2]);
  });

  it('holds the record for every call when told it never lets go', async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: Infinity });

    for (let call = 0; call < 5; call++) {
      const [answer] = await org.connection.sobject('Account').update([{ Id: HUB, Name: 'Hub' }]);
      expect(answer.success).toBe(false);
    }
    expect(org.written).toEqual([]);
  });
});
