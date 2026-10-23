import { describe, it, expect } from 'vitest';
import { DUPLICATE_RULE_MESSAGE, duplicateRuleOrg } from './duplicateRuleOrg.js';

/** A job the org opens, run to its end with `csv` uploaded. */
async function runJob(org: ReturnType<typeof duplicateRuleOrg>, csv: string) {
  const job = org.connection.bulk2.createJob({ operation: 'insert', object: 'Account' }) as {
    open: () => Promise<void>;
    uploadData: (csv: string) => Promise<void>;
    close: () => Promise<void>;
    getAllResults: () => Promise<Array<{ success: boolean; id?: string; errors?: string[] }>>;
  };
  await job.open();
  await job.uploadData(csv);
  await job.close();
  return job.getAllResults();
}

describe('duplicateRuleOrg', () => {
  it('refuses a twin in a Bulk API job and saves the other rows, keeping what each job was sent', async () => {
    const org = duplicateRuleOrg();

    const results = await runJob(org, 'Name\n"Acme"\n"Twin Acme"\n');

    expect(results[0]).toMatchObject({ success: true });
    expect(results[1]).toEqual({
      success: false,
      errors: [`DUPLICATES_DETECTED:${DUPLICATE_RULE_MESSAGE}:--`],
    });
    expect(org.jobs).toEqual([
      { object: 'Account', rows: [{ Name: 'Acme' }, { Name: 'Twin Acme' }] },
    ]);
  });

  it('saves a twin over REST with the duplicate-rule header, and refuses it without', async () => {
    const org = duplicateRuleOrg();
    const accounts = org.connection.sobject('Account');

    const withHeader = await accounts.create([{ Name: 'Twin Acme' }], {
      headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' },
    });
    const without = await accounts.create([{ Name: 'Twin Acme' }]);

    expect(withHeader[0]).toMatchObject({ success: true });
    expect(without[0]).toMatchObject({
      success: false,
      errors: [{ statusCode: 'DUPLICATES_DETECTED', message: DUPLICATE_RULE_MESSAGE }],
    });
    expect(org.rest.map((call) => call.headers)).toEqual([
      { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' },
      undefined,
    ]);
  });

  it('refuses a twin over REST whatever the header when the rule blocks, a lead by its last name too', async () => {
    const org = duplicateRuleOrg({ blocks: true });

    const answer = await org.connection
      .sobject('Lead')
      .create([{ LastName: 'Twin Doe' }, { LastName: 'Doe' }], {
        headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' },
      });

    expect(answer[0]).toMatchObject({ success: false });
    expect(answer[1]).toMatchObject({ success: true });
  });

  it('makes a new id for every record it saves', async () => {
    const org = duplicateRuleOrg();

    const results = await runJob(org, 'Name\n"A"\n"B"\n');
    const rest = await org.connection.sobject('Account').create([{ Name: 'C' }]);
    const ids = [...results.map((r) => r.id), (rest[0] as { id: string }).id];

    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => typeof id === 'string' && id.length === 18)).toBe(true);
  });
});
