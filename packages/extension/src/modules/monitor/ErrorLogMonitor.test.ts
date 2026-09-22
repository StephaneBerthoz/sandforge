import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorLogMonitor } from './ErrorLogMonitor';
import type { ErrorLogEntry, QueryErrorsFn } from './ErrorLogMonitor';

function createMockErrors(): ErrorLogEntry[] {
  return [
    {
      id: 'err-1',
      errorType: 'System.NullPointerException',
      message: 'Attempt to de-reference a null object',
      timestamp: '2026-01-01T10:00:00Z',
      user: 'user-1',
    },
    {
      id: 'err-2',
      errorType: 'System.DmlException',
      message: 'REQUIRED_FIELD_MISSING',
      stackTrace: 'at AccountTrigger line 15',
      timestamp: '2026-01-01T10:05:00Z',
      user: 'user-2',
    },
    {
      id: 'err-3',
      errorType: 'System.NullPointerException',
      message: 'Attempt to de-reference a null object',
      timestamp: '2026-01-01T10:10:00Z',
      user: 'user-1',
      context: 'AccountHandler',
    },
    {
      id: 'err-4',
      errorType: 'System.LimitException',
      message: 'Too many SOQL queries',
      timestamp: '2026-01-01T10:15:00Z',
    },
  ];
}

describe('ErrorLogMonitor', () => {
  let monitor: ErrorLogMonitor;
  let queryErrors: QueryErrorsFn;

  beforeEach(() => {
    queryErrors = vi
      .fn<QueryErrorsFn>()
      .mockResolvedValue({ records: createMockErrors(), truncated: false });
    monitor = new ErrorLogMonitor(queryErrors);
  });

  describe('fetch', () => {
    it('should fetch errors and return them', async () => {
      const errors = await monitor.fetch('org-1');
      expect(errors).toHaveLength(4);
    });

    it('should call queryErrors with orgId and a since timestamp', async () => {
      await monitor.fetch('org-1');
      expect(queryErrors).toHaveBeenCalledWith('org-1', expect.any(String));
    });

    it('should cache fetched errors', async () => {
      await monitor.fetch('org-1');
      expect(monitor.getRecentErrors('org-1')).toHaveLength(4);
    });

    it('reads the last 24 hours on every fetch, not from the last error seen', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02T09:00:00Z'));
      try {
        await monitor.fetch('org-1');
        vi.mocked(queryErrors).mockClear();

        await monitor.fetch('org-1');
        const secondCallArg = vi.mocked(queryErrors).mock.calls[0][1];
        expect(secondCallArg).toBe('2026-01-01T09:00:00.000Z');
      } finally {
        vi.useRealTimers();
      }
    });

    it('lists the same errors on every fetch while no new one is logged', async () => {
      // The org's answer: newest first, strictly after `since`, as the ApexLog
      // query in MonitorOpsFactory asks. Each fetch used to start at the last
      // entry of the previous one, which that order makes the oldest, and `>`
      // left it out: the panel's count went 3, 2, 1, 0 on successive loads of
      // an org whose logs had not changed.
      const logs: ErrorLogEntry[] = [
        {
          id: 'l3',
          errorType: 'Failed',
          message: 'Api - Failed',
          timestamp: '2026-01-02T08:30:00Z',
        },
        {
          id: 'l2',
          errorType: 'Failed',
          message: 'Api - Failed',
          timestamp: '2026-01-02T08:20:00Z',
        },
        {
          id: 'l1',
          errorType: 'Failed',
          message: 'Api - Failed',
          timestamp: '2026-01-02T08:10:00Z',
        },
      ];
      const org = new ErrorLogMonitor((_orgId, since) =>
        Promise.resolve({
          records: logs.filter((l) => Date.parse(l.timestamp) > Date.parse(since)),
          truncated: false,
        }),
      );
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02T09:00:00Z'));
      try {
        const counts: number[] = [];
        for (let i = 0; i < 4; i++) counts.push((await org.fetch('org-1')).length);
        expect(counts).toEqual([3, 3, 3, 3]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should use a default timestamp for the first fetch', async () => {
      await monitor.fetch('org-1');
      const firstCallArg = vi.mocked(queryErrors).mock.calls[0][1];
      expect(firstCallArg).toBeDefined();
      expect(new Date(firstCallArg).getTime()).not.toBeNaN();
    });
  });

  describe('getRecentErrors', () => {
    it('should return empty array for unknown org', () => {
      expect(monitor.getRecentErrors('unknown')).toEqual([]);
    });

    it('should return all cached errors', async () => {
      await monitor.fetch('org-1');
      const errors = monitor.getRecentErrors('org-1');
      expect(errors).toHaveLength(4);
      expect(errors[0].id).toBe('err-1');
    });
  });

  describe('isTruncated', () => {
    it('says whether the last read of an org stopped at its bound', async () => {
      vi.mocked(queryErrors).mockResolvedValueOnce({
        records: createMockErrors(),
        truncated: true,
      });
      await monitor.fetch('org-1');
      expect(monitor.isTruncated('org-1')).toBe(true);

      await monitor.fetch('org-1');
      expect(monitor.isTruncated('org-1')).toBe(false);
    });

    it('is false for an org never read', () => {
      expect(monitor.isTruncated('unknown')).toBe(false);
    });
  });

  describe('getErrorsByType', () => {
    it('should group errors by their error type', async () => {
      await monitor.fetch('org-1');
      const grouped = monitor.getErrorsByType('org-1');

      expect(grouped.get('System.NullPointerException')).toBe(2);
      expect(grouped.get('System.DmlException')).toBe(1);
      expect(grouped.get('System.LimitException')).toBe(1);
    });

    it('should return an empty map for unknown org', () => {
      const grouped = monitor.getErrorsByType('unknown');
      expect(grouped.size).toBe(0);
    });

    it('should handle a single error type', async () => {
      vi.mocked(queryErrors).mockResolvedValue({
        records: [createMockErrors()[0]],
        truncated: false,
      });
      await monitor.fetch('org-1');
      const grouped = monitor.getErrorsByType('org-1');

      expect(grouped.size).toBe(1);
      expect(grouped.get('System.NullPointerException')).toBe(1);
    });
  });
});
