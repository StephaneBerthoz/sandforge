import { describe, expect, it } from 'vitest';
import { compositeOrg, orgError, stampedRows } from './compositeOrg.js';

const API = '/services/data/v66.0';

/** A composite body of GET subrequests at `urls`. */
function body(urls: string[], headers?: Record<string, string>): string {
  return JSON.stringify({
    allOrNone: false,
    compositeRequest: urls.map((url, index) => ({
      method: 'GET',
      url,
      referenceId: `r${index}`,
      ...(headers ? { httpHeaders: headers } : {}),
    })),
  });
}

/** The answers of a composite, as the org gives them. */
type Answers = { compositeResponse: Array<{ httpStatusCode: number; body: unknown }> };

describe('compositeOrg: the data API as the org answered it', () => {
  it('runs five queries of a composite and halts the sixth while the call itself answers', async () => {
    const org = compositeOrg({
      tables: { Account: stampedRows('Account', 3, '2026-10-20T10:00:00Z') },
    });
    const query = `${API}/query?q=${encodeURIComponent('SELECT Id FROM Account')}`;
    const answer = (await org.conn.request({
      method: 'POST',
      url: '/composite',
      body: body(Array.from({ length: 6 }, () => query)),
    })) as Answers;

    expect(answer.compositeResponse.map((sub) => sub.httpStatusCode)).toEqual([
      200, 200, 200, 200, 200, 400,
    ]);
    expect(answer.compositeResponse[5].body).toEqual([
      expect.objectContaining({ errorCode: 'PROCESSING_HALTED' }),
    ]);
  });

  it('refuses a composite of twenty-six subrequests whole', async () => {
    const org = compositeOrg({ tables: { Account: [] } });
    const describe = `${API}/sobjects/Account/describe`;

    await expect(
      org.conn.request({
        method: 'POST',
        url: '/composite',
        body: body(Array.from({ length: 26 }, () => describe)),
      }),
    ).rejects.toMatchObject({ errorCode: 'LIMIT_EXCEEDED' });
  });

  it('answers a describe that did not change since the date asked with 304 and no body', async () => {
    const org = compositeOrg({
      tables: { Account: [] },
      describedAt: { Account: '2026-10-01T00:00:00Z' },
    });
    const describe = `${API}/sobjects/Account/describe`;
    const since = (date: string) =>
      org.conn.request({
        method: 'POST',
        url: '/composite',
        body: body([describe], { 'If-Modified-Since': new Date(date).toUTCString() }),
      }) as Promise<Answers>;

    expect((await since('2026-10-22T00:00:00Z')).compositeResponse[0]).toMatchObject({
      httpStatusCode: 304,
      body: null,
    });
    expect((await since('2000-01-01T00:00:00Z')).compositeResponse[0]).toMatchObject({
      httpStatusCode: 200,
      body: { name: 'Account' },
    });
  });

  it('reads the recycle bin and archived activities with queryAll only', async () => {
    const org = compositeOrg({
      tables: {
        Task: [
          { Id: 'T1', SystemModstamp: '2026-10-20T10:00:00Z' },
          { Id: 'T2', SystemModstamp: '2026-10-20T10:00:01Z', IsArchived: true },
          { Id: 'T3', SystemModstamp: '2026-10-20T10:00:02Z', IsDeleted: true },
        ],
      },
    });

    const live = await org.conn.query('SELECT Id FROM Task');
    const all = await org.conn.query('SELECT Id FROM Task', { scanAll: true });
    const kept = await org.conn.query('SELECT Id FROM Task WHERE IsDeleted = false', {
      scanAll: true,
    });

    expect(live.records.map((row) => row.Id)).toEqual(['T1']);
    expect(all.records.map((row) => row.Id)).toEqual(['T1', 'T2', 'T3']);
    expect(kept.records.map((row) => row.Id)).toEqual(['T1', 'T2']);
  });

  it('drops the milliseconds of a datetime literal, as the org does', async () => {
    const org = compositeOrg({
      tables: { Account: [{ Id: 'A1', SystemModstamp: '2026-10-20T10:00:04.000Z' }] },
    });

    const below = await org.conn.query(
      'SELECT Id FROM Account WHERE SystemModstamp < 2026-10-20T10:00:04.500Z',
    );

    expect(below.records).toEqual([]);
  });

  it('pages a cursor as told, and refuses the next page of a cursor it released', async () => {
    const org = compositeOrg({
      tables: { Contact: stampedRows('Contact', 10, '2026-10-20T10:00:00Z') },
      pageSize: (page) => (page === 0 ? 4 : 3),
      cursorLimit: 1,
    });

    const first = await org.conn.query('SELECT Id FROM Contact');
    const second = await org.conn.queryMore(first.nextRecordsUrl ?? '');
    await org.conn.query('SELECT Id FROM Contact');

    expect([first.records.length, second.records.length, second.done]).toEqual([4, 3, false]);
    await expect(org.conn.queryMore(second.nextRecordsUrl ?? '')).rejects.toMatchObject({
      errorCode: 'INVALID_QUERY_LOCATOR',
    });
  });

  it('answers COUNT() with the count and no rows', async () => {
    const org = compositeOrg({ tables: { Case: stampedRows('Case', 7, '2026-10-20T10:00:00Z') } });

    const page = await org.conn.query('SELECT COUNT() FROM Case');

    expect(page).toMatchObject({ records: [], totalSize: 7, done: true });
  });

  it('refuses a statement it cannot read rather than selecting nothing', async () => {
    const org = compositeOrg({ tables: { Account: [] } });

    await expect(org.conn.query('SELECT Id FROM Account WHERE Name LIKE x')).rejects.toThrow(
      /Not a term/,
    );
    expect(orgError('X', 'y')).toMatchObject({ errorCode: 'X', name: 'X', message: 'y' });
  });
});
