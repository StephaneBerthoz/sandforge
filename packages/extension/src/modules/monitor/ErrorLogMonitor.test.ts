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
    queryErrors = vi.fn<QueryErrorsFn>().mockResolvedValue(createMockErrors());
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

    it('should use last known timestamp for subsequent fetches', async () => {
      await monitor.fetch('org-1');
      vi.mocked(queryErrors).mockClear();

      await monitor.fetch('org-1');
      const secondCallArg = vi.mocked(queryErrors).mock.calls[0][1];
      expect(secondCallArg).toBe('2026-01-01T10:15:00Z');
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

  describe('getErrorCount', () => {
    it('should return 0 for unknown org', () => {
      expect(monitor.getErrorCount('unknown')).toBe(0);
    });

    it('should return the count of cached errors', async () => {
      await monitor.fetch('org-1');
      expect(monitor.getErrorCount('org-1')).toBe(4);
    });

    it('should return 0 when no errors exist', async () => {
      vi.mocked(queryErrors).mockResolvedValue([]);
      await monitor.fetch('org-1');
      expect(monitor.getErrorCount('org-1')).toBe(0);
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
      vi.mocked(queryErrors).mockResolvedValue([createMockErrors()[0]]);
      await monitor.fetch('org-1');
      const grouped = monitor.getErrorsByType('org-1');

      expect(grouped.size).toBe(1);
      expect(grouped.get('System.NullPointerException')).toBe(1);
    });
  });
});
