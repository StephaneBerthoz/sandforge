import { describe, expect, it } from 'vitest';

import { SlicedOrg, type SlicedRow } from './slicedOrg.js';

/** The `n`-th contact, created long before any run. */
function contact(n: number): SlicedRow {
  return {
    Id: `003${String(n).padStart(12, '0')}AAA`,
    LastName: n % 2 === 0 ? `Even${n}` : `Odd${n}`,
    Email: `person${n}@example.com`,
    CreatedDate: '2020-01-01T00:00:00.000Z',
  };
}

type Answer = {
  records: Array<Record<string, unknown>>;
  done: boolean;
  totalSize: number;
  nextRecordsUrl?: string;
};

function connectionOf(org: SlicedOrg) {
  return org.connection as unknown as {
    query: (soql: string, options?: { headers?: Record<string, string> }) => Promise<Answer>;
    queryMore: (url: string) => Promise<Answer>;
    sobject: (name: string) => {
      update: (batch: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>>;
    };
    soap: { getServerTimestamp: () => Promise<{ timestamp: string }> };
    request: (r: string | { url: string }) => Promise<unknown>;
    limitInfo?: unknown;
  };
}

describe('SlicedOrg', () => {
  it('reads past an Id, by Id, under a LIMIT, saying what the statement selects, a page at a time', async () => {
    const org = new SlicedOrg([5, 1, 4, 2, 3].map(contact));
    const conn = connectionOf(org);

    const first = await conn.query(
      `SELECT Id, Email FROM Contact WHERE Id > '${contact(1).Id}' ORDER BY Id LIMIT 3`,
      { headers: { 'Sforce-Query-Options': 'batchSize=2' } },
    );
    expect(first.totalSize).toBe(3);
    expect(first.done).toBe(false);
    expect(first.records.map((r) => r.Id)).toEqual([contact(2).Id, contact(3).Id]);
    const next = await conn.queryMore(String(first.nextRecordsUrl));
    expect(next.records.map((r) => r.Id)).toEqual([contact(4).Id]);
    expect(next.done).toBe(true);
    expect(Object.keys(next.records[0]).sort()).toEqual(['Email', 'Id', 'attributes']);
  });

  it('keeps the rows of a filter, a range, a list of ids and a creation date', async () => {
    let now = Date.parse('2026-11-14T10:00:00.000Z');
    const org = new SlicedOrg([1, 2, 3, 4].map(contact), { now: () => now });
    const conn = connectionOf(org);
    now += 5_000;
    org.insert({ ...contact(5), CreatedDate: undefined } as unknown as SlicedRow);

    const counted = async (where: string) =>
      (await conn.query(`SELECT COUNT() FROM Contact WHERE ${where}`)).totalSize;
    expect(await counted("(LastName LIKE 'Even%')")).toBe(2);
    expect(await counted(`Id > '${contact(1).Id}' AND Id <= '${contact(3).Id}'`)).toBe(2);
    expect(await counted(`Id IN ('${contact(2).Id}', '${contact(9).Id}')`)).toBe(1);
    expect(await counted('CreatedDate >= 2026-11-14T10:00:00Z')).toBe(1);
  });

  it('refuses a column its describe does not list, and a read too large for it, as the org does', async () => {
    const org = new SlicedOrg([1, 2, 3].map(contact), { timeoutAbove: 2 });
    const conn = connectionOf(org);

    await expect(conn.query('SELECT Id, Phone FROM Contact')).rejects.toMatchObject({
      errorCode: 'INVALID_FIELD',
    });
    await expect(conn.query('SELECT Id FROM Contact ORDER BY Id LIMIT 3')).rejects.toMatchObject({
      errorCode: 'QUERY_TIMEOUT',
    });
    await expect(conn.query('SELECT Id FROM Contact ORDER BY Id LIMIT 2')).resolves.toMatchObject({
      totalSize: 2,
    });
  });

  it('writes an update, refuses one of a row deleted since, and keeps every call in order', async () => {
    const org = new SlicedOrg([1, 2].map(contact));
    const conn = connectionOf(org);
    org.delete(contact(2).Id);

    const results = await conn.sobject('Contact').update([
      { Id: contact(1).Id, Email: 'masked@example.com' },
      { Id: contact(2).Id, Email: 'masked@example.com' },
    ]);

    expect(results[0]).toEqual({ success: true, id: contact(1).Id });
    expect(results[1]).toMatchObject({
      success: false,
      errors: [{ statusCode: 'ENTITY_IS_DELETED' }],
    });
    expect(org.row(contact(1).Id)?.Email).toBe('masked@example.com');
    expect(org.journal).toEqual([{ kind: 'update', ids: [contact(1).Id, contact(2).Id] }]);
  });

  it('says its clock, its limits, its own figure of the rows, and its usage as jsforce keeps it', async () => {
    const org = new SlicedOrg([1, 2, 3].map(contact), {
      now: () => Date.parse('2026-11-14T10:00:00.000Z'),
      limits: { Max: 15_000, Remaining: 14_000 },
    });
    const conn = connectionOf(org);
    org.limitInfo = { apiUsage: { used: 1000, limit: 15_000 } };

    expect(await conn.soap.getServerTimestamp()).toEqual({ timestamp: '2026-11-14T10:00:00.000Z' });
    expect(await conn.request({ url: '/limits' })).toEqual({
      DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
    });
    expect(await conn.request('/services/data/v62.0/limits/recordCount?sObjects=Contact')).toEqual({
      sObjects: [{ name: 'Contact', count: 3 }],
    });
    expect(conn.limitInfo).toEqual({ apiUsage: { used: 1000, limit: 15_000 } });
  });
});
