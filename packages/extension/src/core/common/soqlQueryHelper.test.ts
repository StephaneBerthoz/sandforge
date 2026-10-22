import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Connection, QueryResult } from 'jsforce';
import {
  queryAll,
  queryAllBounded,
  queryWithFieldsFallback,
  queryWithFieldsFallbackBounded,
} from './soqlQueryHelper';

type TestRecord = Record<string, unknown>;

/** Create a minimal mock jsforce Connection */
function createMockConnection(): {
  query: ReturnType<typeof vi.fn>;
  queryMore: ReturnType<typeof vi.fn>;
  describe: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(),
    queryMore: vi.fn(),
    describe: vi.fn(),
  };
}

function makeQueryResult<T extends Record<string, unknown>>(
  records: T[],
  done: boolean,
  nextRecordsUrl?: string,
): QueryResult<T> {
  return {
    done,
    totalSize: records.length,
    records,
    ...(nextRecordsUrl ? { nextRecordsUrl } : {}),
  } as QueryResult<T>;
}

describe('soqlQueryHelper', () => {
  let mockConn: ReturnType<typeof createMockConnection>;

  beforeEach(() => {
    mockConn = createMockConnection();
  });

  describe('queryAll', () => {
    it('should return records from a single page result', async () => {
      const records = [{ Id: '001', Name: 'Acme' }];
      mockConn.query.mockResolvedValue(makeQueryResult(records, true));

      const result = await queryAll<TestRecord>(
        mockConn as unknown as Connection,
        'SELECT Id, Name FROM Account',
      );

      expect(result).toEqual(records);
      expect(mockConn.query).toHaveBeenCalledWith('SELECT Id, Name FROM Account');
      expect(mockConn.queryMore).not.toHaveBeenCalled();
    });

    it('should paginate through multiple pages via queryMore', async () => {
      const page1 = [{ Id: '001' }, { Id: '002' }];
      const page2 = [{ Id: '003' }, { Id: '004' }];
      const page3 = [{ Id: '005' }];

      mockConn.query.mockResolvedValue(
        makeQueryResult(page1, false, '/services/data/v58.0/query/next1'),
      );
      mockConn.queryMore
        .mockResolvedValueOnce(makeQueryResult(page2, false, '/services/data/v58.0/query/next2'))
        .mockResolvedValueOnce(makeQueryResult(page3, true));

      const result = await queryAll<TestRecord>(
        mockConn as unknown as Connection,
        'SELECT Id FROM Account',
      );

      expect(result).toEqual([...page1, ...page2, ...page3]);
      expect(result).toHaveLength(5);
      expect(mockConn.queryMore).toHaveBeenCalledTimes(2);
      expect(mockConn.queryMore).toHaveBeenCalledWith('/services/data/v58.0/query/next1');
      expect(mockConn.queryMore).toHaveBeenCalledWith('/services/data/v58.0/query/next2');
    });

    it('should return empty array when no records are found', async () => {
      mockConn.query.mockResolvedValue(makeQueryResult([], true));

      const result = await queryAll<TestRecord>(
        mockConn as unknown as Connection,
        'SELECT Id FROM Account WHERE Id = null',
      );

      expect(result).toEqual([]);
    });

    it('should stop pagination when done is true even without nextRecordsUrl', async () => {
      const records = [{ Id: '001' }];
      mockConn.query.mockResolvedValue(makeQueryResult(records, true));

      const result = await queryAll<TestRecord>(
        mockConn as unknown as Connection,
        'SELECT Id FROM Account',
      );

      expect(result).toEqual(records);
      expect(mockConn.queryMore).not.toHaveBeenCalled();
    });

    it('should propagate query errors', async () => {
      mockConn.query.mockRejectedValue(new Error('INVALID_SESSION_ID'));

      await expect(
        queryAll<TestRecord>(mockConn as unknown as Connection, 'SELECT Id FROM Account'),
      ).rejects.toThrow('INVALID_SESSION_ID');
    });

    it('should propagate queryMore errors', async () => {
      mockConn.query.mockResolvedValue(makeQueryResult([{ Id: '001' }], false, '/next'));
      mockConn.queryMore.mockRejectedValue(new Error('CONNECTION_RESET'));

      await expect(
        queryAll<TestRecord>(mockConn as unknown as Connection, 'SELECT Id FROM Account'),
      ).rejects.toThrow('CONNECTION_RESET');
    });
  });

  describe('queryWithFieldsFallback', () => {
    /** jsforce's HttpApiError: the code travels in `errorCode` and `name`, never in the message. */
    function platformError(message: string, errorCode: string): Error {
      const err = new Error(message);
      err.name = errorCode;
      return Object.assign(err, { errorCode });
    }

    it('retries with the described fields when the org refuses the query by error code alone', async () => {
      mockConn.query
        .mockRejectedValueOnce(
          platformError(
            'The SOQL FIELDS function must have a LIMIT of at most 200',
            'MALFORMED_QUERY',
          ),
        )
        .mockResolvedValueOnce(makeQueryResult([{ Id: '001', Name: 'Acme' }], true));
      mockConn.describe.mockResolvedValue({ fields: [{ name: 'Id' }, { name: 'Name' }] });

      const result = await queryWithFieldsFallback<TestRecord>(
        mockConn as unknown as Connection,
        'Account',
        'SELECT FIELDS(ALL) FROM Account LIMIT 200',
      );

      expect(result).toEqual([{ Id: '001', Name: 'Acme' }]);
      expect(mockConn.query).toHaveBeenLastCalledWith('SELECT Id, Name FROM Account LIMIT 200');
    });

    it('still surfaces a refusal whose code has nothing to do with FIELDS()', async () => {
      mockConn.query.mockRejectedValueOnce(
        platformError('Session expired or invalid', 'INVALID_SESSION_ID'),
      );

      await expect(
        queryWithFieldsFallback<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          'SELECT FIELDS(ALL) FROM Account LIMIT 200',
        ),
      ).rejects.toThrow('Session expired or invalid');
      expect(mockConn.describe).not.toHaveBeenCalled();
    });

    it.each([
      ['with the described fields', 'SELECT FIELDS(ALL) FROM Account LIMIT 500', 500],
      ['as written', 'SELECT FIELDS(ALL) FROM Account LIMIT 50', 50],
      ['without a LIMIT', 'SELECT FIELDS(ALL) FROM Account', undefined],
    ])('says which LIMIT a read sent %s carried', async (_case, soql, limit) => {
      mockConn.describe.mockResolvedValue({ fields: [{ name: 'Id' }, { name: 'Name' }] });
      mockConn.query.mockResolvedValue(makeQueryResult([{ Id: '001', Name: 'Acme' }], true));

      const read = await queryWithFieldsFallbackBounded<TestRecord>(
        mockConn as unknown as Connection,
        'Account',
        soql,
      );

      expect(read).toEqual({ records: [{ Id: '001', Name: 'Acme' }], limit });
    });

    it.each([
      ['a LIMIT above 200', 'SELECT FIELDS(ALL) FROM Account LIMIT 500', ' LIMIT 500'],
      ['no LIMIT at all', 'SELECT FIELDS(ALL) FROM Account', ''],
    ])(
      'never sends the FIELDS(ALL) query the platform refuses with %s',
      async (_case, soql, tail) => {
        mockConn.describe.mockResolvedValue({ fields: [{ name: 'Id' }, { name: 'Name' }] });
        mockConn.query.mockResolvedValue(makeQueryResult([{ Id: '001', Name: 'Acme' }], true));

        const result = await queryWithFieldsFallback<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          soql,
        );

        expect(result).toEqual([{ Id: '001', Name: 'Acme' }]);
        expect(mockConn.query).toHaveBeenCalledTimes(1);
        expect(mockConn.query).toHaveBeenCalledWith(`SELECT Id, Name FROM Account${tail}`);
      },
    );

    describe('on an object too wide to name its fields in the query', () => {
      // jsforce sends a query as a GET with the SOQL in the URL, so every
      // described field lengthens it. 700 custom fields encode to about 27,000
      // characters.
      const wideDescribe = {
        fields: Array.from({ length: 700 }, (_, i) => ({
          name: `Custom_Field_${String(i).padStart(3, '0')}__c`,
          custom: true,
        })),
      };

      /**
       * An org of 500 accounts that answers the fields a statement names,
       * honours `Id IN` and LIMIT, and refuses a URI past what it holds.
       */
      const answering = (statement: string) => {
        if (encodeURIComponent(statement).length > 15_400) {
          return Promise.reject(
            Object.assign(new Error('URI Too Long'), { errorCode: 'ERROR_HTTP_414' }),
          );
        }
        const named = /^SELECT (.+?) FROM /.exec(statement)?.[1].split(', ') ?? [];
        const ids = new Set([...statement.matchAll(/'(001\d{15})'/g)].map((m) => m[1]));
        const limit = /LIMIT (\d+)$/.exec(statement);
        const rows = Array.from({ length: 500 }, (_, n) => `001${String(n).padStart(15, '0')}`)
          .filter((id) => ids.size === 0 || ids.has(id))
          .slice(0, limit ? Number(limit[1]) : undefined)
          .map((Id) =>
            Object.fromEntries(named.map((field) => [field, field === 'Id' ? Id : 'v'])),
          );
        return Promise.resolve(makeQueryResult(rows, true));
      };

      it('reads the rows asked for, not the 200 FIELDS(ALL) allows, each with every field', async () => {
        // Sent at FIELDS(ALL) LIMIT 200, a production-tier Sync copied 200
        // of the 500 rows it asked for, and said nothing.
        mockConn.describe.mockResolvedValue(wideDescribe);
        mockConn.query.mockImplementation(answering);

        const read = await queryWithFieldsFallbackBounded<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          'SELECT FIELDS(ALL) FROM Account LIMIT 500',
        );

        expect(read.limit).toBe(500);
        expect(read.records).toHaveLength(500);
        // The id every group carries, and the 700 fields.
        expect(Object.keys(read.records[499])).toHaveLength(701);
        for (const [sent] of mockConn.query.mock.calls) {
          expect(String(sent)).not.toContain('FIELDS(ALL)');
          expect(encodeURIComponent(String(sent)).length).toBeLessThanOrEqual(14_000);
        }
      });

      it('reads every field of every row when the query reads without a LIMIT, within the URI', async () => {
        // Sent whole, the described query was refused with a 414.
        mockConn.describe.mockResolvedValue(wideDescribe);
        mockConn.query.mockImplementation(answering);

        const records = await queryWithFieldsFallback<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          'SELECT FIELDS(ALL) FROM Account',
        );

        expect(records).toHaveLength(500);
        expect(records[0]['Custom_Field_699__c']).toBe('v');
        for (const [sent] of mockConn.query.mock.calls) {
          expect(encodeURIComponent(String(sent)).length).toBeLessThanOrEqual(14_000);
        }
      });
    });

    it('should return results directly when FIELDS() syntax is supported', async () => {
      const records = [{ Id: '001', Name: 'Acme', Industry: 'Tech' }];
      mockConn.query.mockResolvedValue(makeQueryResult(records, true));

      const result = await queryWithFieldsFallback<TestRecord>(
        mockConn as unknown as Connection,
        'Account',
        'SELECT FIELDS(ALL) FROM Account LIMIT 200',
      );

      expect(result).toEqual(records);
      expect(mockConn.describe).not.toHaveBeenCalled();
    });

    it('should fallback to describe when FIELDS(ALL) is not supported', async () => {
      mockConn.query
        .mockRejectedValueOnce(new Error('FIELDS(ALL) is not supported in this org'))
        .mockResolvedValueOnce(makeQueryResult([{ Id: '001', Name: 'Acme' }], true));

      mockConn.describe.mockResolvedValue({
        fields: [
          { name: 'Id', custom: false },
          { name: 'Name', custom: false },
          { name: 'Custom__c', custom: true },
        ],
      });

      const result = await queryWithFieldsFallback<TestRecord>(
        mockConn as unknown as Connection,
        'Account',
        'SELECT FIELDS(ALL) FROM Account LIMIT 200',
      );

      expect(result).toEqual([{ Id: '001', Name: 'Acme' }]);
      expect(mockConn.describe).toHaveBeenCalledWith('Account');
      // The fallback query should include all fields (ALL mode)
      expect(mockConn.query).toHaveBeenCalledTimes(2);
      const fallbackQuery = mockConn.query.mock.calls[1][0] as string;
      expect(fallbackQuery).toContain('Id');
      expect(fallbackQuery).toContain('Name');
      expect(fallbackQuery).toContain('Custom__c');
      expect(fallbackQuery).not.toContain('FIELDS(ALL)');
    });

    it('should fallback to describe with only standard fields for FIELDS(STANDARD)', async () => {
      mockConn.query
        .mockRejectedValueOnce(new Error('MALFORMED_QUERY'))
        .mockResolvedValueOnce(makeQueryResult([{ Id: '001', Name: 'Acme' }], true));

      mockConn.describe.mockResolvedValue({
        fields: [
          { name: 'Id', custom: false },
          { name: 'Name', custom: false },
          { name: 'Custom__c', custom: true },
        ],
      });

      const result = await queryWithFieldsFallback<TestRecord>(
        mockConn as unknown as Connection,
        'Account',
        'SELECT FIELDS(STANDARD) FROM Account LIMIT 200',
      );

      expect(result).toEqual([{ Id: '001', Name: 'Acme' }]);
      const fallbackQuery = mockConn.query.mock.calls[1][0] as string;
      expect(fallbackQuery).toContain('Id');
      expect(fallbackQuery).toContain('Name');
      expect(fallbackQuery).not.toContain('Custom__c');
      expect(fallbackQuery).not.toContain('FIELDS(STANDARD)');
    });

    it('should detect INVALID_FIELD errors and trigger fallback', async () => {
      mockConn.query
        .mockRejectedValueOnce(new Error('INVALID_FIELD: FIELDS(ALL)'))
        .mockResolvedValueOnce(makeQueryResult([{ Id: '001' }], true));

      mockConn.describe.mockResolvedValue({
        fields: [{ name: 'Id', custom: false }],
      });

      const result = await queryWithFieldsFallback<TestRecord>(
        mockConn as unknown as Connection,
        'Account',
        'SELECT FIELDS(ALL) FROM Account LIMIT 200',
      );

      expect(result).toEqual([{ Id: '001' }]);
      expect(mockConn.describe).toHaveBeenCalledTimes(1);
    });

    it('should detect "not supported" errors and trigger fallback', async () => {
      mockConn.query
        .mockRejectedValueOnce(new Error('Feature not supported for this org type'))
        .mockResolvedValueOnce(makeQueryResult([{ Id: '001' }], true));

      mockConn.describe.mockResolvedValue({
        fields: [{ name: 'Id', custom: false }],
      });

      const result = await queryWithFieldsFallback<TestRecord>(
        mockConn as unknown as Connection,
        'Account',
        'SELECT FIELDS(ALL) FROM Account LIMIT 200',
      );

      expect(result).toEqual([{ Id: '001' }]);
    });

    it('should rethrow non-FIELDS-related errors without fallback', async () => {
      mockConn.query.mockRejectedValue(new Error('INSUFFICIENT_ACCESS: cannot query this object'));

      await expect(
        queryWithFieldsFallback<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          'SELECT FIELDS(ALL) FROM Account LIMIT 200',
        ),
      ).rejects.toThrow('INSUFFICIENT_ACCESS');

      expect(mockConn.describe).not.toHaveBeenCalled();
    });

    it('should handle non-Error thrown values', async () => {
      mockConn.query.mockRejectedValue('some string error');

      await expect(
        queryWithFieldsFallback<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          'SELECT FIELDS(ALL) FROM Account LIMIT 200',
        ),
      ).rejects.toBe('some string error');

      expect(mockConn.describe).not.toHaveBeenCalled();
    });

    it('should propagate errors from the fallback query', async () => {
      mockConn.query
        .mockRejectedValueOnce(new Error('FIELDS( is not valid'))
        .mockRejectedValueOnce(new Error('QUERY_TIMEOUT'));

      mockConn.describe.mockResolvedValue({
        fields: [{ name: 'Id', custom: false }],
      });

      await expect(
        queryWithFieldsFallback<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          'SELECT FIELDS(ALL) FROM Account LIMIT 200',
        ),
      ).rejects.toThrow('QUERY_TIMEOUT');
    });

    it('should propagate errors from describe', async () => {
      mockConn.query.mockRejectedValue(new Error('MALFORMED_QUERY: FIELDS(ALL)'));
      mockConn.describe.mockRejectedValue(new Error('NO_ACCESS: cannot describe Account'));

      await expect(
        queryWithFieldsFallback<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          'SELECT FIELDS(ALL) FROM Account LIMIT 200',
        ),
      ).rejects.toThrow('NO_ACCESS');
    });
  });
});

describe('queryAllBounded — saying when a bound cut the read', () => {
  it('says so when pages were still waiting', async () => {
    const conn = {
      query: vi.fn().mockResolvedValue({
        records: [{ Id: '1' }, { Id: '2' }],
        done: false,
        nextRecordsUrl: '/more',
      }),
      queryMore: vi.fn(),
    } as unknown as Connection;

    const read = await queryAllBounded(conn, 'SELECT Id FROM Account', 2);

    expect(read.records).toHaveLength(2);
    expect(read.truncated).toBe(true);
  });

  it('says so when the rows land exactly on the cap', async () => {
    // A statement carrying its own `LIMIT 2000` stops there with `done: true`,
    // and that is precisely how a backup of the first two thousand rows of an
    // object was reported as complete.
    const conn = {
      query: vi.fn().mockResolvedValue({ records: [{ Id: '1' }, { Id: '2' }], done: true }),
      queryMore: vi.fn(),
    } as unknown as Connection;

    const read = await queryAllBounded(conn, 'SELECT Id FROM Account LIMIT 2', 2);

    expect(read.truncated).toBe(true);
  });

  it('says nothing when the read finished on its own', async () => {
    const conn = {
      query: vi.fn().mockResolvedValue({ records: [{ Id: '1' }], done: true }),
      queryMore: vi.fn(),
    } as unknown as Connection;

    const read = await queryAllBounded(conn, 'SELECT Id FROM Account', 2000);

    expect(read.truncated).toBe(false);
  });

  it('follows the pages and stops at the cap', async () => {
    const conn = {
      query: vi
        .fn()
        .mockResolvedValue({ records: [{ Id: '1' }], done: false, nextRecordsUrl: '/more' }),
      queryMore: vi.fn().mockResolvedValue({
        records: [{ Id: '2' }, { Id: '3' }],
        done: false,
        nextRecordsUrl: '/more2',
      }),
    } as unknown as Connection;

    const read = await queryAllBounded(conn, 'SELECT Id FROM Account', 2);

    expect(read.records).toHaveLength(2);
    expect(read.truncated).toBe(true);
  });

  it('leaves queryAll answering exactly as it did', async () => {
    const conn = {
      query: vi.fn().mockResolvedValue({ records: [{ Id: '1' }], done: true }),
      queryMore: vi.fn(),
    } as unknown as Connection;

    await expect(queryAll(conn, 'SELECT Id FROM Account')).resolves.toEqual([{ Id: '1' }]);
  });
});

describe('queryAll — stopped by a signal', () => {
  it('asks for no further page once the signal aborts, and rejects with its reason', async () => {
    const stop = new AbortController();
    const queryMore = vi.fn();
    const conn = {
      query: vi.fn(async () => {
        stop.abort();
        return { records: [{ Id: '1' }], done: false, nextRecordsUrl: '/more' };
      }),
      queryMore,
    } as unknown as Connection;

    const outcome = await queryAll(conn, 'SELECT Id FROM Account', undefined, stop.signal).catch(
      (reason: unknown) => reason,
    );

    expect(outcome).toBe(stop.signal.reason);
    expect(queryMore).not.toHaveBeenCalled();
  });

  it('sends no query at all once it has aborted', async () => {
    const stop = new AbortController();
    stop.abort();
    const query = vi.fn();
    const conn = { query, queryMore: vi.fn() } as unknown as Connection;

    await expect(queryAllBounded(conn, 'SELECT Id FROM Account', 10, stop.signal)).rejects.toBe(
      stop.signal.reason,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
