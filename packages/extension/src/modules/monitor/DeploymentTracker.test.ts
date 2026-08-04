import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeploymentTracker } from './DeploymentTracker';
import type { DeploymentInfo, QueryDeploymentsFn } from './DeploymentTracker';

function createMockDeployments(): DeploymentInfo[] {
  return [
    {
      id: 'dep-1',
      status: 'InProgress',
      startDate: '2026-01-01T10:00:00Z',
      createdBy: 'user-1',
      componentCount: 25,
      errorCount: 0,
    },
    {
      id: 'dep-2',
      status: 'Succeeded',
      startDate: '2026-01-01T08:00:00Z',
      completedDate: '2026-01-01T08:15:00Z',
      createdBy: 'user-2',
      componentCount: 10,
      errorCount: 0,
    },
    {
      id: 'dep-3',
      status: 'Failed',
      startDate: '2026-01-01T06:00:00Z',
      completedDate: '2026-01-01T06:05:00Z',
      createdBy: 'user-1',
      componentCount: 5,
      errorCount: 3,
    },
    {
      id: 'dep-4',
      status: 'Pending',
      startDate: '2026-01-01T12:00:00Z',
      createdBy: 'user-3',
      componentCount: 50,
      errorCount: 0,
    },
    {
      id: 'dep-5',
      status: 'Canceled',
      startDate: '2026-01-01T04:00:00Z',
      completedDate: '2026-01-01T04:01:00Z',
      createdBy: 'user-2',
      componentCount: 2,
      errorCount: 0,
    },
  ];
}

describe('DeploymentTracker', () => {
  let tracker: DeploymentTracker;
  let queryDeployments: QueryDeploymentsFn;

  beforeEach(() => {
    queryDeployments = vi
      .fn<Parameters<QueryDeploymentsFn>, ReturnType<QueryDeploymentsFn>>()
      .mockResolvedValue(createMockDeployments());
    tracker = new DeploymentTracker(queryDeployments);
  });

  describe('fetch', () => {
    it('should fetch deployments and return them', async () => {
      const deployments = await tracker.fetch('org-1');
      expect(deployments).toHaveLength(5);
    });

    it('should call queryDeployments with the correct orgId', async () => {
      await tracker.fetch('org-1');
      expect(queryDeployments).toHaveBeenCalledWith('org-1');
    });

    it('should cache fetched deployments', async () => {
      await tracker.fetch('org-1');
      const active = tracker.getActiveDeployments('org-1');
      expect(active.length).toBeGreaterThan(0);
    });
  });

  describe('getActiveDeployments', () => {
    it('should return only Pending and InProgress deployments', async () => {
      await tracker.fetch('org-1');
      const active = tracker.getActiveDeployments('org-1');

      expect(active).toHaveLength(2);
      const ids = active.map((d) => d.id);
      expect(ids).toContain('dep-1');
      expect(ids).toContain('dep-4');
    });

    it('should return empty array for unknown org', () => {
      expect(tracker.getActiveDeployments('unknown')).toEqual([]);
    });

    it('should return empty when no deployments are active', async () => {
      vi.mocked(queryDeployments).mockResolvedValue([{ ...createMockDeployments()[1] }]);
      await tracker.fetch('org-1');
      expect(tracker.getActiveDeployments('org-1')).toEqual([]);
    });
  });

  describe('getRecentDeployments', () => {
    it('should return deployments sorted by start date descending', async () => {
      await tracker.fetch('org-1');
      const recent = tracker.getRecentDeployments('org-1', 5);

      expect(recent[0].id).toBe('dep-4');
      expect(recent[1].id).toBe('dep-1');
      expect(recent[4].id).toBe('dep-5');
    });

    it('should limit results to the requested count', async () => {
      await tracker.fetch('org-1');
      const recent = tracker.getRecentDeployments('org-1', 2);

      expect(recent).toHaveLength(2);
    });

    it('should return empty array for unknown org', () => {
      expect(tracker.getRecentDeployments('unknown', 5)).toEqual([]);
    });

    it('should handle count larger than available deployments', async () => {
      await tracker.fetch('org-1');
      const recent = tracker.getRecentDeployments('org-1', 100);
      expect(recent).toHaveLength(5);
    });

    it('should return empty array when count is 0', async () => {
      await tracker.fetch('org-1');
      const recent = tracker.getRecentDeployments('org-1', 0);
      expect(recent).toEqual([]);
    });
  });
});
