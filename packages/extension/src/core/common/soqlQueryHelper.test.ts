import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Connection, QueryResult } from 'jsforce';
import { queryAll, queryWithFieldsFallback } from './soqlQueryHelper';

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

      it('samples through FIELDS(ALL) at the 200 rows the platform allows', async () => {
        mockConn.describe.mockResolvedValue(wideDescribe);
        mockConn.query.mockResolvedValue(makeQueryResult([{ Id: '001' }], true));

        await queryWithFieldsFallback<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          'SELECT FIELDS(ALL) FROM Account LIMIT 500',
        );

        expect(mockConn.query).toHaveBeenCalledTimes(1);
        const sent = String(mockConn.query.mock.calls[0][0]);
        expect(sent).toBe('SELECT FIELDS(ALL) FROM Account LIMIT 200');
        expect(encodeURIComponent(sent).length).toBeLessThanOrEqual(15_000);
      });

      it('still names every field when the query reads without a LIMIT', async () => {
        // Capping it at 200 rows would silently drop records the caller reads
        // in full, so the long query is sent and a refusal surfaces as one.
        mockConn.describe.mockResolvedValue(wideDescribe);
        mockConn.query.mockResolvedValue(makeQueryResult([{ Id: '001' }], true));

        await queryWithFieldsFallback<TestRecord>(
          mockConn as unknown as Connection,
          'Account',
          'SELECT FIELDS(ALL) FROM Account',
        );

        const sent = String(mockConn.query.mock.calls[0][0]);
        expect(sent).toContain('Custom_Field_699__c');
        expect(sent).not.toContain('LIMIT');
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
