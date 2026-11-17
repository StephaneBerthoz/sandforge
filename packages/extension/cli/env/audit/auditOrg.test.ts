import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Connection } from 'jsforce';
import { TimeoutError } from '../../../src/core/engine/TimeoutManager.js';
import {
  AuditOrg,
  fieldOf,
  instantOf,
  textOf,
  unreadReasonOf,
  type AuditTransport,
} from './auditOrg.js';
import { fakeAuditOrg, sfError } from './auditFakeOrg.js';

const TABLE = {
  columns: ['Id', 'Name'],
  rows: Array.from({ length: 5 }, (_, at) => ({ Id: `a00xx00000000${at}`, Name: `row ${at}` })),
};

describe('the org as the audits read it', () => {
  it('reads through the connection sandforge env reaches an org with, as it is', () => {
    expectTypeOf<Pick<Connection, 'request'>>().toExtend<AuditTransport>();
  });

  it('counts every request it sends, one the org refuses included, since the org counted it', async () => {
    const { transport } = fakeAuditOrg({
      data: { Thing__c: TABLE },
      refuse: { Other__c: sfError('INVALID_TYPE', "sObject type 'Other__c' is not supported.") },
    });
    const org = new AuditOrg(transport);
    await org.query('SELECT Id, Name FROM Thing__c');
    await expect(org.query('SELECT Id FROM Other__c')).rejects.toThrow(/not supported/);
    expect(org.requests).toBe(2);
  });

  it('follows the pages of a query to its end, each page a request', async () => {
    const { transport, requests } = fakeAuditOrg({ data: { Thing__c: TABLE }, pageSize: 2 });
    const org = new AuditOrg(transport);
    const rows = await org.query('SELECT Id, Name FROM Thing__c');
    expect(rows.records.map((row) => row['Name'])).toEqual([
      'row 0',
      'row 1',
      'row 2',
      'row 3',
      'row 4',
    ]);
    expect(rows.truncated).toBe(false);
    expect(requests).toHaveLength(3);
  });

  it('stops at its page bound and says the rows past it were not read', async () => {
    const { transport } = fakeAuditOrg({ data: { Thing__c: TABLE }, pageSize: 2 });
    const rows = await new AuditOrg(transport).query('SELECT Id FROM Thing__c', { maxPages: 2 });
    expect(rows.records).toHaveLength(4);
    expect(rows.truncated).toBe(true);
  });

  it('follows a locator on the API’s own path only, never to another host', async () => {
    const org = new AuditOrg({
      request: async () => ({
        done: false,
        nextRecordsUrl: 'https://elsewhere.example/steal',
        records: [{ Id: 'a00xx0000000001' }],
      }),
    });
    const rows = await org.query('SELECT Id FROM Thing__c');
    expect(org.requests).toBe(1);
    expect(rows.truncated).toBe(true);
  });

  it('asks the Tooling API for a Tooling query', async () => {
    const { transport, requests } = fakeAuditOrg({
      tooling: { RemoteProxy: { columns: ['SiteName'], rows: [] } },
    });
    await new AuditOrg(transport).query('SELECT SiteName FROM RemoteProxy', { tooling: true });
    expect(requests[0]).toMatch(/^\/tooling\/query\?q=/);
  });

  it('refuses an answer no query gives rather than taking it for no rows', async () => {
    const org = new AuditOrg({ request: async () => ({ hello: 'world' }) });
    await expect(org.query('SELECT Id FROM Thing__c')).rejects.toThrow(
      'its answer is not one a query gives',
    );
  });

  it('waits for each answer a bounded time, and says so in seconds', async () => {
    const org = new AuditOrg({ request: () => new Promise(() => undefined) }, { timeoutMs: 20 });
    const failed = await org.get('/query?q=x').catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(TimeoutError);
    expect(unreadReasonOf(new TimeoutError('env:audit', 30_000))).toBe(
      'the org did not answer within 30 s',
    );
  });

  it('gives the org’s words for a refusal on one line, its code first, bounded', () => {
    const reason = unreadReasonOf(
      sfError('INVALID_FIELD', `No such column\n'Foo__c' on entity 'Bar__mdt'.${' x'.repeat(400)}`),
    );
    expect(reason.startsWith('the org refused it: INVALID_FIELD')).toBe(true);
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThanOrEqual(300);
  });

  it('reads a field whatever the case the query named it in, as the API answers its own', () => {
    const row = { Endpoint__c: 'https://erp.example.com', IsActive: true, Blank__c: ' ' };
    expect(fieldOf(row, 'endpoint__c')).toBe('https://erp.example.com');
    expect(textOf(row, 'ENDPOINT__C')).toBe('https://erp.example.com');
    expect(textOf(row, 'Blank__c')).toBeUndefined();
    expect(textOf(row, 'IsActive')).toBeUndefined();
  });

  it('reads the API’s instants, offset without a colon, as UTC instants', () => {
    expect(instantOf('2026-11-21T06:00:00.000+0000')).toBe('2026-11-21T06:00:00.000Z');
    expect(instantOf('2026-11-21T07:00:00.000+0100')).toBe('2026-11-21T06:00:00.000Z');
    expect(instantOf('not a date')).toBeUndefined();
    expect(instantOf(null)).toBeUndefined();
  });
});
