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
