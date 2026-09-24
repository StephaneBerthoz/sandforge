import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloneRecordFetcher } from './CloneRecordFetcher.js';
import type { Connection } from 'jsforce';

function createMockConnection(): Connection {
  return {
    query: vi.fn(),
    queryMore: vi.fn(),
    describe: vi.fn().mockResolvedValue({
      fields: [
        { name: 'Id', createable: false, type: 'id' },
        { name: 'Name', createable: true, type: 'string' },
        { name: 'AccountId', createable: true, type: 'reference' },
        { name: 'CreatedDate', createable: false, type: 'datetime' },
      ],
    }),
  } as unknown as Connection;
}

describe('CloneRecordFetcher', () => {
  let fetcher: CloneRecordFetcher;
  let conn: Connection;

  beforeEach(() => {
    fetcher = new CloneRecordFetcher({ log: vi.fn() });
    conn = createMockConnection();
  });

  it('fetches all records with cursor-based pagination via queryMore', async () => {
    const mockQuery = vi.mocked(conn.query);
    const mockQueryMore = vi.mocked(conn.queryMore);

    mockQuery.mockResolvedValueOnce({
      done: false,
      totalSize: 3,
      records: [{ Id: '001', Name: 'A', attributes: { type: 'Contact' } }],
      nextRecordsUrl: '/services/data/v59.0/query/01g-next',
    } as unknown as Awaited<ReturnType<typeof conn.query>>);

    mockQueryMore.mockResolvedValueOnce({
      done: false,
      totalSize: 3,
      records: [{ Id: '002', Name: 'B', attributes: { type: 'Contact' } }],
      nextRecordsUrl: '/services/data/v59.0/query/01g-next2',
    } as unknown as Awaited<ReturnType<typeof conn.queryMore>>);

    mockQueryMore.mockResolvedValueOnce({
      done: true,
      totalSize: 3,
      records: [{ Id: '003', Name: 'C', attributes: { type: 'Contact' } }],
    } as unknown as Awaited<ReturnType<typeof conn.queryMore>>);

    const records = await fetcher.fetchRecords(conn, 'Contact');

    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({ Id: '001', Name: 'A' });
    expect(records[2]).toEqual({ Id: '003', Name: 'C' });
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQueryMore).toHaveBeenCalledTimes(2);
    // Verify no OFFSET in query
    const soql = mockQuery.mock.calls[0][0] as string;
    expect(soql).not.toContain('OFFSET');
  });

  it('countRecords returns the total count', async () => {
    const mockQuery = vi.mocked(conn.query);
    mockQuery.mockResolvedValueOnce({
      done: true,
      totalSize: 42,
      records: [],
    } as unknown as Awaited<ReturnType<typeof conn.query>>);

    const count = await fetcher.countRecords(conn, 'Account');
    expect(count).toBe(42);
    const soql = mockQuery.mock.calls[0][0] as string;
    expect(soql).toContain('SELECT COUNT() FROM Account');
  });

  it('countRecords appends WHERE clause', async () => {
    const mockQuery = vi.mocked(conn.query);
    mockQuery.mockResolvedValueOnce({
      done: true,
      totalSize: 5,
      records: [],
    } as unknown as Awaited<ReturnType<typeof conn.query>>);

    await fetcher.countRecords(conn, 'Account', "Type = 'Customer'");
    const soql = mockQuery.mock.calls[0][0] as string;
    expect(soql).toContain("WHERE Type = 'Customer'");
  });

  it('fetchSample respects the limit parameter', async () => {
    const mockQuery = vi.mocked(conn.query);
    mockQuery.mockResolvedValueOnce({
      done: true,
      totalSize: 2,
      records: [
        { Id: '001', Name: 'X', attributes: { type: 'Account' } },
        { Id: '002', Name: 'Y', attributes: { type: 'Account' } },
      ],
    } as unknown as Awaited<ReturnType<typeof conn.query>>);

    const records = await fetcher.fetchSample(conn, 'Account', 5);
    expect(records).toHaveLength(2);
    expect(records[0]).not.toHaveProperty('attributes');
    const soql = mockQuery.mock.calls[0][0] as string;
    expect(soql).toContain('LIMIT 5');
  });

  describe('the describe its queries take their fields from', () => {
    beforeEach(() => {
      vi.mocked(conn.query).mockResolvedValue({
        done: true,
        totalSize: 0,
        records: [],
      } as unknown as Awaited<ReturnType<typeof conn.query>>);
    });

    it('asks the org once per object, however many of its queries it builds', async () => {
      // A preview described each object for its order and again for its
      // sample: ten describes of the source for five objects.
      const described = await fetcher.describe(conn, 'Account');
      await fetcher.fetchSample(conn, 'Account', 5);
      await fetcher.fetchRecords(conn, 'Account');

      expect(conn.describe).toHaveBeenCalledTimes(1);
      expect(described.fields.map((field) => field.name)).toContain('AccountId');
      // The fields each query reads are the ones that describe lists.
      expect(vi.mocked(conn.query).mock.calls.map(([soql]) => soql)).toEqual([
        'SELECT Id, Name, AccountId FROM Account LIMIT 5',
        'SELECT Id, Name, AccountId FROM Account',
      ]);
    });

    it('asks again for another object, in another org, and for another fetcher', async () => {
      // One fetcher serves one preview or one run: the next one reads a field
      // deployed in between.
      const otherOrg = createMockConnection();
      await fetcher.fetchRecords(conn, 'Account');
      await fetcher.fetchRecords(conn, 'Contact');
      await fetcher.describe(otherOrg, 'Account');
      await new CloneRecordFetcher({ log: vi.fn() }).fetchRecords(conn, 'Account');

      expect(vi.mocked(conn.describe).mock.calls.map(([name]) => name)).toEqual([
        'Account',
        'Contact',
        'Account',
      ]);
      expect(otherOrg.describe).toHaveBeenCalledTimes(1);
    });
  });

  describe('the rows a copy sends', () => {
    /** What `rowsACopySends` gives a feed item. */
    const NOT_TRACKED = "Type != 'TrackedChange'";

    beforeEach(() => {
      vi.mocked(conn.query).mockResolvedValue({
        done: true,
        totalSize: 4,
        records: [],
      } as unknown as Awaited<ReturnType<typeof conn.query>>);
    });

    it('counts under the filter only the rows the copy sends, the filter bracketed', async () => {
      // Unbracketed, the OR of the filter would reach past the condition.
      const count = await fetcher.countRecords(
        conn,
        'FeedItem',
        "Type = 'TextPost' OR Title = null",
        [NOT_TRACKED],
      );

      expect(count).toBe(4);
      expect(conn.query).toHaveBeenCalledWith(
        "SELECT COUNT() FROM FeedItem WHERE (Type = 'TextPost' OR Title = null) AND Type != 'TrackedChange'",
      );
    });

    it('samples only the rows the copy sends, with or without a filter', async () => {
      await fetcher.fetchSample(conn, 'FeedItem', 5, undefined, [NOT_TRACKED]);

      const soql = vi.mocked(conn.query).mock.calls[0][0] as string;
      expect(soql).toMatch(/ FROM FeedItem WHERE Type != 'TrackedChange' LIMIT 5$/);
    });
  });

  describe('a WHERE clause that does more than filter is refused before any query', () => {
    it.each(['Id != null LIMIT 1', "Name = 'x' FOR UPDATE"])(
      'fetchRecords refuses %j',
      async (where) => {
        await expect(fetcher.fetchRecords(conn, 'Account', where)).rejects.toThrow();
        expect(conn.query).not.toHaveBeenCalled();
      },
    );

    it.each(['Id != null LIMIT 1', "Name = 'x' FOR UPDATE"])(
      'countRecords refuses %j',
      async (where) => {
        await expect(fetcher.countRecords(conn, 'Account', where)).rejects.toThrow();
        expect(conn.query).not.toHaveBeenCalled();
      },
    );

    it('fetchSample refuses a clause carrying its own LIMIT', async () => {
      await expect(fetcher.fetchSample(conn, 'Account', 5, 'Id != null LIMIT 1')).rejects.toThrow();
      expect(conn.query).not.toHaveBeenCalled();
    });

    it('sends a filter whose literal spells a keyword unchanged', async () => {
      vi.mocked(conn.query).mockResolvedValueOnce({
        done: true,
        totalSize: 0,
        records: [],
      } as unknown as Awaited<ReturnType<typeof conn.query>>);

      await fetcher.fetchRecords(conn, 'Account', "Status = 'Delete pending'");

      const soql = vi.mocked(conn.query).mock.calls[0][0] as string;
      expect(soql).toMatch(/ WHERE Status = 'Delete pending'$/);
    });
  });

  it('handles empty result gracefully', async () => {
    const mockQuery = vi.mocked(conn.query);
    mockQuery.mockResolvedValueOnce({
      done: true,
      totalSize: 0,
      records: [],
    } as unknown as Awaited<ReturnType<typeof conn.query>>);

    const records = await fetcher.fetchRecords(conn, 'EmptyObject__c');
    expect(records).toEqual([]);
  });
});
