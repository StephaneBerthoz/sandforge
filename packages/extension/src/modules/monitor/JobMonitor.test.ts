import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobMonitor } from './JobMonitor';
import type { JobInfo, QueryJobsFn } from './JobMonitor';

function createMockJobs(): JobInfo[] {
  return [
    {
      id: 'job-1',
      jobType: 'Bulk',
      status: 'Processing',
      objectType: 'Account',
      createdBy: 'user-1',
      createdDate: '2026-01-01T00:00:00Z',
      totalRecords: 1000,
      processedRecords: 500,
      failedRecords: 0,
    },
    {
      id: 'job-2',
      jobType: 'Batch',
      status: 'Completed',
      objectType: 'Contact',
      createdBy: 'user-2',
      createdDate: '2026-01-01T01:00:00Z',
      completedDate: '2026-01-01T01:30:00Z',
      totalRecords: 200,
      processedRecords: 200,
      failedRecords: 0,
    },
    {
      id: 'job-3',
      jobType: 'Future',
      status: 'Failed',
      createdBy: 'user-1',
      createdDate: '2026-01-01T02:00:00Z',
      failedRecords: 50,
    },
    {
      id: 'job-4',
      jobType: 'Queueable',
      status: 'Queued',
      createdBy: 'user-3',
      createdDate: '2026-01-01T03:00:00Z',
    },
    {
      id: 'job-5',
      jobType: 'Scheduled',
      status: 'Aborted',
      createdBy: 'user-2',
      createdDate: '2026-01-01T04:00:00Z',
    },
  ];
}

describe('JobMonitor', () => {
  let monitor: JobMonitor;
  let queryJobs: QueryJobsFn;

  beforeEach(() => {
    queryJobs = vi.fn<QueryJobsFn>().mockResolvedValue(createMockJobs());
    monitor = new JobMonitor(queryJobs);
  });

  describe('fetch', () => {
    it('should fetch jobs and return them', async () => {
      const jobs = await monitor.fetch('org-1');
      expect(jobs).toHaveLength(5);
    });

    it('should call queryJobs with the correct orgId', async () => {
      await monitor.fetch('org-1');
      expect(queryJobs).toHaveBeenCalledWith('org-1');
    });

    it('should cache the fetched jobs', async () => {
      await monitor.fetch('org-1');
      const active = monitor.getActiveJobs('org-1');
      expect(active.length).toBeGreaterThan(0);
    });
  });

  describe('getActiveJobs', () => {
    it('should return only Queued and Processing jobs', async () => {
      await monitor.fetch('org-1');
      const active = monitor.getActiveJobs('org-1');

      expect(active).toHaveLength(2);
      expect(active.map((j) => j.id)).toEqual(['job-1', 'job-4']);
    });

    it('should return empty array for unknown org', () => {
      expect(monitor.getActiveJobs('unknown')).toEqual([]);
    });

    it('should return empty when all jobs are completed', async () => {
      vi.mocked(queryJobs).mockResolvedValue([
        { ...createMockJobs()[0], status: 'Completed' },
      ]);
      await monitor.fetch('org-1');
      expect(monitor.getActiveJobs('org-1')).toEqual([]);
    });
  });

  describe('getFailedJobs', () => {
    it('should return only Failed jobs', async () => {
      await monitor.fetch('org-1');
      const failed = monitor.getFailedJobs('org-1');

      expect(failed).toHaveLength(1);
      expect(failed[0].id).toBe('job-3');
    });

    it('should return empty array when no jobs have failed', async () => {
      vi.mocked(queryJobs).mockResolvedValue([
        { ...createMockJobs()[0], status: 'Completed' },
      ]);
      await monitor.fetch('org-1');
      expect(monitor.getFailedJobs('org-1')).toEqual([]);
    });

    it('should return empty array for unknown org', () => {
      expect(monitor.getFailedJobs('unknown')).toEqual([]);
    });
  });

  describe('getJobStats', () => {
    it('should return correct aggregate statistics', async () => {
      await monitor.fetch('org-1');
      const stats = monitor.getJobStats('org-1');

      expect(stats.total).toBe(5);
      expect(stats.active).toBe(2);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
    });

    it('should return all zeros for unknown org', () => {
      const stats = monitor.getJobStats('unknown');
      expect(stats).toEqual({ total: 0, active: 0, completed: 0, failed: 0 });
    });

    it('should handle empty job list', async () => {
      vi.mocked(queryJobs).mockResolvedValue([]);
      await monitor.fetch('org-1');
      const stats = monitor.getJobStats('org-1');
      expect(stats).toEqual({ total: 0, active: 0, completed: 0, failed: 0 });
    });
  });
});
