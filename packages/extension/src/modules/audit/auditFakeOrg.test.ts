import { describe, expect, it } from 'vitest';
import { fakeAuditOrg } from './auditFakeOrg.js';

const q = (soql: string, tooling = false): string =>
  `/${tooling ? 'tooling/' : ''}query?q=${encodeURIComponent(soql)}`;

describe('the fake org of the audits', () => {
  const { transport } = fakeAuditOrg({
    data: {
      CronTrigger: {
        columns: ['CronJobDetail.Name', 'State', 'OwnerId'],
        rows: [
          { 'CronJobDetail.Name': 'Nightly', State: 'WAITING', OwnerId: '005xx0000001AAAAAA' },
        ],
      },
      User: {
        columns: ['Id', 'Username', 'Email'],
        rows: [
          { Id: '005xx0000001AAAAAA', Username: 'ops@example.com.uat', Email: 'ops@example.com' },
        ],
      },
    },
    tooling: { NamedCredential: { columns: ['DeveloperName', 'Endpoint'], rows: [] } },
  });

  it('answers the fields a query names alone, a relationship’s nested as the API nests it', async () => {
    const answer = (await transport.request({
      method: 'GET',
      url: q('select cronjobdetail.name, state from crontrigger'),
    })) as { records: Array<Record<string, unknown>> };
    expect(answer.records[0]).toEqual({
      attributes: { type: 'CronTrigger' },
      CronJobDetail: { attributes: { type: 'CronJobDetail' }, Name: 'Nightly' },
      State: 'WAITING',
    });
  });

  it('selects rows by a list of ids, a 15-character id matching its 18-character form', async () => {
    const answer = (await transport.request({
      method: 'GET',
      url: q("SELECT Username FROM User WHERE Id IN ('005xx0000001AAA')"),
    })) as { records: Array<Record<string, unknown>> };
    expect(answer.records).toEqual([
      { attributes: { type: 'User' }, Username: 'ops@example.com.uat' },
    ]);
  });

  it('refuses a field its table does not have, and a table its endpoint does not hold', async () => {
    await expect(
      transport.request({ method: 'GET', url: q('SELECT Nope__c FROM User') }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_FIELD' });
    await expect(
      transport.request({ method: 'GET', url: q('SELECT DeveloperName FROM NamedCredential') }),
    ).rejects.toMatchObject({ errorCode: 'INVALID_TYPE' });
  });

  it('throws on a statement it cannot read rather than answer nothing', async () => {
    await expect(
      transport.request({ method: 'GET', url: q("SELECT Id FROM User WHERE Name = 'x'") }),
    ).rejects.toThrow('Not a statement the fake org reads');
  });
});
