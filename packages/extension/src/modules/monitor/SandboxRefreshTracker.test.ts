import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SandboxRefreshTracker } from './SandboxRefreshTracker';
import type {
  SandboxRefreshEvent,
  QuerySandboxesFn,
  RefreshDetectedFn,
  SeenRefreshStore,
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

/** A store that outlives the trackers built on it, like the ConfigStore-backed one. */
function sharedStore(): SeenRefreshStore & { saved: Map<string, string[]> } {
  const saved = new Map<string, string[]>();
  return {
    saved,
    load: (orgId) => saved.get(orgId),
    save: (orgId, keys) => {
      saved.set(orgId, keys);
    },
  };
}

describe('SandboxRefreshTracker', () => {
  let tracker: SandboxRefreshTracker;
  let querySandboxes: QuerySandboxesFn;
  let onRefreshDetected: RefreshDetectedFn;

  beforeEach(() => {
    querySandboxes = vi
      .fn<QuerySandboxesFn>()
      .mockResolvedValue({ supported: true, events: createMockRefreshEvents(), truncated: false });
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

    it('records the history it finds on its first read without reporting any of it', async () => {
      // The first read used to report every row it found, which is why the
      // callback was left unconnected: an old refresh is not news.
      await tracker.fetch('org-1');
      expect(onRefreshDetected).not.toHaveBeenCalled();
    });

    it('should not re-notify for already-known events on subsequent fetch', async () => {
      await tracker.fetch('org-1');
      vi.mocked(onRefreshDetected).mockClear();
      await tracker.fetch('org-1');
      expect(onRefreshDetected).not.toHaveBeenCalled();
    });

    it('reports a refresh that completes after the first read, once', async () => {
      await tracker.fetch('org-1');

      const completed: SandboxRefreshEvent = {
        orgId: 'org-1',
        sandboxName: 'new-sandbox',
        refreshDate: '2026-01-05T10:00:00Z',
        status: 'Completed',
      };
      vi.mocked(querySandboxes).mockResolvedValue({
        supported: true,
        truncated: false,
        events: [completed, ...createMockRefreshEvents()],
      });

      await tracker.fetch('org-1');
      await tracker.fetch('org-1');
      expect(onRefreshDetected).toHaveBeenCalledTimes(1);
      expect(onRefreshDetected).toHaveBeenCalledWith(completed);
    });

    it('waits for a refresh in progress to complete before reporting it', async () => {
      await tracker.fetch('org-1');

      const pending: SandboxRefreshEvent = {
        orgId: 'org-1',
        sandboxName: 'uat',
        refreshDate: '2026-01-06T09:00:00Z',
        status: 'Processing',
      };
      vi.mocked(querySandboxes).mockResolvedValue({
        supported: true,
        truncated: false,
        events: [pending],
      });
      await tracker.fetch('org-1');
      expect(onRefreshDetected).not.toHaveBeenCalled();

      vi.mocked(querySandboxes).mockResolvedValue({
        supported: true,
        truncated: false,
        events: [{ ...pending, status: 'Completed' }],
      });
      await tracker.fetch('org-1');
      expect(onRefreshDetected).toHaveBeenCalledTimes(1);
      expect(vi.mocked(onRefreshDetected).mock.calls[0][0].sandboxName).toBe('uat');
    });

    it('reports to a tracker built after a restart a refresh completed in between', async () => {
      const store = sharedStore();
      await new SandboxRefreshTracker(querySandboxes, onRefreshDetected, store).fetch('org-1');
      expect(store.saved.get('org-1')).toEqual(['dev-sandbox:2026-01-01T10:00:00Z']);

      const completed: SandboxRefreshEvent = {
        orgId: 'org-1',
        sandboxName: 'qa-sandbox',
        refreshDate: '2026-01-02T08:00:00Z',
        status: 'Completed',
      };
      vi.mocked(querySandboxes).mockResolvedValue({
        supported: true,
        truncated: false,
        events: [
          completed,
          ...createMockRefreshEvents().filter((e) => e.sandboxName !== 'qa-sandbox'),
        ],
      });
      await new SandboxRefreshTracker(querySandboxes, onRefreshDetected, store).fetch('org-1');

      // The history the first tracker saw is not reported again; the refresh
      // that completed while no tracker ran is.
      expect(onRefreshDetected).toHaveBeenCalledTimes(1);
      expect(onRefreshDetected).toHaveBeenCalledWith(completed);
    });

    it('remembers nothing about an org that cannot be asked', async () => {
      const store = sharedStore();
      vi.mocked(querySandboxes).mockResolvedValue({
        supported: false,
        truncated: false,
        events: [],
      });

      await new SandboxRefreshTracker(querySandboxes, onRefreshDetected, store).fetch('org-sbx');

      expect(store.saved.has('org-sbx')).toBe(false);
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

  describe('isTruncated', () => {
    it('says whether the last read of an org stopped at its bound', async () => {
      vi.mocked(querySandboxes).mockResolvedValueOnce({
        supported: true,
        events: createMockRefreshEvents(),
        truncated: true,
      });
      await tracker.fetch('org-1');
      expect(tracker.isTruncated('org-1')).toBe(true);

      await tracker.fetch('org-1');
      expect(tracker.isTruncated('org-1')).toBe(false);
      expect(tracker.isTruncated('unknown')).toBe(false);
    });
  });

  describe('isRefreshInProgress', () => {
    it('should return true when a sandbox is Processing', async () => {
      await tracker.fetch('org-1');
      expect(tracker.isRefreshInProgress('org-1')).toBe(true);
    });

    it('should return true when a sandbox is Pending', async () => {
      vi.mocked(querySandboxes).mockResolvedValue({
        supported: true,
        truncated: false,
        events: [
          {
            orgId: 'org-1',
            sandboxName: 'test',
            refreshDate: '2026-01-01T00:00:00Z',
            status: 'Pending',
          },
        ],
      });
      await tracker.fetch('org-1');
      expect(tracker.isRefreshInProgress('org-1')).toBe(true);
    });

    it('should return false when all sandboxes are Completed', async () => {
      vi.mocked(querySandboxes).mockResolvedValue({
        supported: true,
        truncated: false,
        events: [
          {
            orgId: 'org-1',
            sandboxName: 'test',
            refreshDate: '2026-01-01T00:00:00Z',
            status: 'Completed',
          },
        ],
      });
      await tracker.fetch('org-1');
      expect(tracker.isRefreshInProgress('org-1')).toBe(false);
    });

    it('should return false when all sandboxes are Failed', async () => {
      vi.mocked(querySandboxes).mockResolvedValue({
        supported: true,
        truncated: false,
        events: [
          {
            orgId: 'org-1',
            sandboxName: 'test',
            refreshDate: '2026-01-01T00:00:00Z',
            status: 'Failed',
          },
        ],
      });
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
