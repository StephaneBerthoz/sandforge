import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SandboxRefreshTracker } from './SandboxRefreshTracker';
import type {
  SandboxRefreshEvent,
  QuerySandboxesFn,
  RefreshDetectedFn,
} from './SandboxRefreshTracker';

function createMockRefreshEvents(): SandboxRefreshEvent[] {
  return [
    {
      orgId: 'org-1',
      sandboxName: 'dev-sandbox',
      refreshDate: '2026-01-01T10:00:00Z',
      status: 'Completed',
      sourceOrg: 'prod-org',
    },
    {
      orgId: 'org-1',
      sandboxName: 'qa-sandbox',
      refreshDate: '2026-01-02T08:00:00Z',
      status: 'Processing',
      sourceOrg: 'prod-org',
    },
    {
      orgId: 'org-1',
      sandboxName: 'staging-sandbox',
      refreshDate: '2026-01-03T12:00:00Z',
      status: 'Pending',
    },
  ];
}

describe('SandboxRefreshTracker', () => {
  let tracker: SandboxRefreshTracker;
  let querySandboxes: QuerySandboxesFn;
  let onRefreshDetected: RefreshDetectedFn;

  beforeEach(() => {
    querySandboxes = vi
      .fn<Parameters<QuerySandboxesFn>, ReturnType<QuerySandboxesFn>>()
      .mockResolvedValue(createMockRefreshEvents());
    onRefreshDetected = vi.fn();
    tracker = new SandboxRefreshTracker(querySandboxes, onRefreshDetected);
  });

  describe('fetch', () => {
    it('should fetch sandbox refresh events', async () => {
      const events = await tracker.fetch('org-1');
      expect(events).toHaveLength(3);
    });

    it('should call querySandboxes with the correct orgId', async () => {
      await tracker.fetch('org-1');
      expect(querySandboxes).toHaveBeenCalledWith('org-1');
    });

    it('should cache fetched events', async () => {
      await tracker.fetch('org-1');
      expect(tracker.getRecentRefreshes('org-1')).toHaveLength(3);
    });

    it('should notify for new refresh events on first fetch', async () => {
      await tracker.fetch('org-1');
      expect(onRefreshDetected).toHaveBeenCalledTimes(3);
    });

    it('should not re-notify for already-known events on subsequent fetch', async () => {
      await tracker.fetch('org-1');
      vi.mocked(onRefreshDetected).mockClear();
      await tracker.fetch('org-1');
      expect(onRefreshDetected).not.toHaveBeenCalled();
    });

    it('should notify only for new events on subsequent fetch', async () => {
      await tracker.fetch('org-1');
      vi.mocked(onRefreshDetected).mockClear();

      const newEvent: SandboxRefreshEvent = {
        orgId: 'org-1',
        sandboxName: 'new-sandbox',
        refreshDate: '2026-01-05T10:00:00Z',
        status: 'Pending',
      };
      vi.mocked(querySandboxes).mockResolvedValue([...createMockRefreshEvents(), newEvent]);

      await tracker.fetch('org-1');
      expect(onRefreshDetected).toHaveBeenCalledTimes(1);
      expect(onRefreshDetected).toHaveBeenCalledWith(newEvent);
    });
  });

  describe('getRecentRefreshes', () => {
    it('should return empty array for unknown org', () => {
      expect(tracker.getRecentRefreshes('unknown')).toEqual([]);
    });

    it('should return cached events', async () => {
      await tracker.fetch('org-1');
      const events = tracker.getRecentRefreshes('org-1');
      expect(events).toHaveLength(3);
      expect(events[0].sandboxName).toBe('dev-sandbox');
    });
  });

  describe('isRefreshInProgress', () => {
    it('should return true when a sandbox is Processing', async () => {
      await tracker.fetch('org-1');
      expect(tracker.isRefreshInProgress('org-1')).toBe(true);
    });

    it('should return true when a sandbox is Pending', async () => {
      vi.mocked(querySandboxes).mockResolvedValue([
        {
          orgId: 'org-1',
          sandboxName: 'test',
          refreshDate: '2026-01-01T00:00:00Z',
          status: 'Pending',
        },
      ]);
      await tracker.fetch('org-1');
      expect(tracker.isRefreshInProgress('org-1')).toBe(true);
    });

    it('should return false when all sandboxes are Completed', async () => {
      vi.mocked(querySandboxes).mockResolvedValue([
        {
          orgId: 'org-1',
          sandboxName: 'test',
          refreshDate: '2026-01-01T00:00:00Z',
          status: 'Completed',
        },
      ]);
      await tracker.fetch('org-1');
      expect(tracker.isRefreshInProgress('org-1')).toBe(false);
    });

    it('should return false when all sandboxes are Failed', async () => {
      vi.mocked(querySandboxes).mockResolvedValue([
        {
          orgId: 'org-1',
          sandboxName: 'test',
          refreshDate: '2026-01-01T00:00:00Z',
          status: 'Failed',
        },
      ]);
      await tracker.fetch('org-1');
      expect(tracker.isRefreshInProgress('org-1')).toBe(false);
    });

    it('should return false for unknown org', () => {
      expect(tracker.isRefreshInProgress('unknown')).toBe(false);
    });
  });

  describe('constructor without callback', () => {
    it('should work without onRefreshDetected callback', async () => {
      const trackerNoCallback = new SandboxRefreshTracker(querySandboxes);
      await trackerNoCallback.fetch('org-1');
      expect(trackerNoCallback.getRecentRefreshes('org-1')).toHaveLength(3);
    });
  });
});
