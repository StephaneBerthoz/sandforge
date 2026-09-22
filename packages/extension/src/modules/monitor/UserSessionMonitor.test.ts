import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserSessionMonitor } from './UserSessionMonitor';
import type { UserSessionInfo, QuerySessionsFn } from './UserSessionMonitor';

function createMockSessions(): UserSessionInfo[] {
  return [
    {
      sessionId: 'session-1',
      userId: 'user-1',
      username: 'admin@sandbox.com',
      sessionType: 'UI',
      loginTime: '2026-01-01T08:00:00Z',
      sourceIp: '192.168.1.1',
    },
    {
      sessionId: 'session-2',
      userId: 'user-2',
      username: 'dev@sandbox.com',
      sessionType: 'API',
      loginTime: '2026-01-01T09:00:00Z',
      sourceIp: '10.0.0.1',
    },
    {
      sessionId: 'session-3',
      userId: 'user-1',
      username: 'admin@sandbox.com',
      sessionType: 'API',
      loginTime: '2026-01-01T08:30:00Z',
      sourceIp: '192.168.1.1',
    },
    {
      sessionId: 'session-4',
      userId: 'user-3',
      username: 'test@sandbox.com',
      sessionType: 'UI',
      loginTime: '2026-01-01T10:00:00Z',
      sourceIp: '172.16.0.1',
    },
  ];
}

describe('UserSessionMonitor', () => {
  let monitor: UserSessionMonitor;
  let querySessions: QuerySessionsFn;

  beforeEach(() => {
    querySessions = vi
      .fn<QuerySessionsFn>()
      .mockResolvedValue({ records: createMockSessions(), truncated: false });
    monitor = new UserSessionMonitor(querySessions);
  });

  describe('fetch', () => {
    it('should fetch sessions and return them', async () => {
      const sessions = await monitor.fetch('org-1');
      expect(sessions).toHaveLength(4);
    });

    it('should call querySessions with the correct orgId', async () => {
      await monitor.fetch('org-1');
      expect(querySessions).toHaveBeenCalledWith('org-1');
    });

    it('should cache the fetched sessions', async () => {
      await monitor.fetch('org-1');
      const active = monitor.getActiveSessions('org-1');
      expect(active).toHaveLength(4);
    });

    it('should overwrite cache on subsequent fetch', async () => {
      await monitor.fetch('org-1');
      vi.mocked(querySessions).mockResolvedValue({
        records: [createMockSessions()[0]],
        truncated: false,
      });
      await monitor.fetch('org-1');
      expect(monitor.getActiveSessions('org-1')).toHaveLength(1);
    });
  });

  describe('getActiveSessions', () => {
    it('should return all cached sessions', async () => {
      await monitor.fetch('org-1');
      const sessions = monitor.getActiveSessions('org-1');
      expect(sessions).toHaveLength(4);
    });

    it('should return empty array for unknown org', () => {
      expect(monitor.getActiveSessions('unknown')).toEqual([]);
    });

    it('should return empty when no sessions exist', async () => {
      vi.mocked(querySessions).mockResolvedValue({ records: [], truncated: false });
      await monitor.fetch('org-1');
      expect(monitor.getActiveSessions('org-1')).toEqual([]);
    });
  });

  describe('isTruncated', () => {
    it('says whether the last read of an org stopped at its bound', async () => {
      vi.mocked(querySessions).mockResolvedValueOnce({
        records: createMockSessions(),
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

  describe('getActiveUserCount', () => {
    it('should return the count of distinct users', async () => {
      await monitor.fetch('org-1');
      expect(monitor.getActiveUserCount('org-1')).toBe(3);
    });

    it('should return 0 for unknown org', () => {
      expect(monitor.getActiveUserCount('unknown')).toBe(0);
    });

    it('should return 0 when no sessions exist', async () => {
      vi.mocked(querySessions).mockResolvedValue({ records: [], truncated: false });
      await monitor.fetch('org-1');
      expect(monitor.getActiveUserCount('org-1')).toBe(0);
    });

    it('should count a user with multiple sessions only once', async () => {
      vi.mocked(querySessions).mockResolvedValue({
        records: [createMockSessions()[0], createMockSessions()[2]],
        truncated: false,
      });
      await monitor.fetch('org-1');
      expect(monitor.getActiveUserCount('org-1')).toBe(1);
    });

    it('should handle a single session', async () => {
      vi.mocked(querySessions).mockResolvedValue({
        records: [createMockSessions()[0]],
        truncated: false,
      });
      await monitor.fetch('org-1');
      expect(monitor.getActiveUserCount('org-1')).toBe(1);
    });
  });
});
