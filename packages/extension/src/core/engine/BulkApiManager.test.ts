import { describe, it, expect, beforeEach } from 'vitest';
import { BulkApiManager } from './BulkApiManager';
import type { BulkJobInfo } from './BulkApiManager';

function createJob(
  id: string,
  overrides?: Partial<BulkJobInfo>
): BulkJobInfo {
  return {
    id,
    operation: 'insert',
    object: 'Account',
    state: 'UploadComplete',
    numberRecordsProcessed: 0,
    numberRecordsFailed: 0,
    totalProcessingTime: 0,
    createdDate: '2026-02-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('BulkApiManager', () => {
  let manager: BulkApiManager;

  beforeEach(() => {
    manager = new BulkApiManager(3);
  });

  describe('registerJob', () => {
    it('should add a job to tracking', () => {
      manager.registerJob(createJob('job-1'));
      expect(manager.totalJobs).toBe(1);
    });

    it('should allow multiple jobs', () => {
      manager.registerJob(createJob('job-1'));
      manager.registerJob(createJob('job-2'));
      expect(manager.totalJobs).toBe(2);
    });

    it('should overwrite a job with the same ID', () => {
      manager.registerJob(createJob('job-1', { object: 'Account' }));
      manager.registerJob(createJob('job-1', { object: 'Contact' }));

      expect(manager.totalJobs).toBe(1);
      expect(manager.getJob('job-1')?.object).toBe('Contact');
    });
  });

  describe('getJob', () => {
    it('should return a registered job', () => {
      manager.registerJob(createJob('job-1'));
      const job = manager.getJob('job-1');

      expect(job).toBeDefined();
      expect(job?.id).toBe('job-1');
    });

    it('should return undefined for unknown ID', () => {
      expect(manager.getJob('nonexistent')).toBeUndefined();
    });
  });

  describe('updateJobState', () => {
    it('should update the state of an existing job', () => {
      manager.registerJob(createJob('job-1'));
      const result = manager.updateJobState('job-1', 'InProgress');

      expect(result).toBe(true);
      expect(manager.getJob('job-1')?.state).toBe('InProgress');
    });

    it('should return false for unknown job', () => {
      expect(manager.updateJobState('nope', 'Failed')).toBe(false);
    });
  });

  describe('updateJobCounts', () => {
    it('should update processed and failed counts', () => {
      manager.registerJob(createJob('job-1'));
      const result = manager.updateJobCounts('job-1', 500, 3);

      expect(result).toBe(true);
      const job = manager.getJob('job-1');
      expect(job?.numberRecordsProcessed).toBe(500);
      expect(job?.numberRecordsFailed).toBe(3);
    });

    it('should return false for unknown job', () => {
      expect(manager.updateJobCounts('nope', 0, 0)).toBe(false);
    });
  });

  describe('updateTotalRecords', () => {
    it('should update total records for an existing job', () => {
      manager.registerJob(createJob('job-1'));
      const result = manager.updateTotalRecords('job-1', 1000);

      expect(result).toBe(true);
      expect(manager.getJob('job-1')?.totalRecords).toBe(1000);
    });

    it('should return false for unknown job', () => {
      expect(manager.updateTotalRecords('nope', 500)).toBe(false);
    });
  });

  describe('getActiveJobs', () => {
    it('should return jobs in UploadComplete or InProgress state', () => {
      manager.registerJob(createJob('job-1', { state: 'UploadComplete' }));
      manager.registerJob(createJob('job-2', { state: 'InProgress' }));
      manager.registerJob(createJob('job-3', { state: 'JobComplete' }));

      const active = manager.getActiveJobs();
      expect(active).toHaveLength(2);
    });

    it('should return empty array when no active jobs', () => {
      manager.registerJob(createJob('job-1', { state: 'JobComplete' }));
      expect(manager.getActiveJobs()).toEqual([]);
    });
  });

  describe('getCompletedJobs', () => {
    it('should return jobs in terminal states', () => {
      manager.registerJob(createJob('job-1', { state: 'JobComplete' }));
      manager.registerJob(createJob('job-2', { state: 'Failed' }));
      manager.registerJob(createJob('job-3', { state: 'Aborted' }));
      manager.registerJob(createJob('job-4', { state: 'InProgress' }));

      const completed = manager.getCompletedJobs();
      expect(completed).toHaveLength(3);
    });

    it('should return empty array when no completed jobs', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));
      expect(manager.getCompletedJobs()).toEqual([]);
    });
  });

  describe('canStartNewJob', () => {
    it('should allow new jobs when under limit', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));
      manager.registerJob(createJob('job-2', { state: 'InProgress' }));

      expect(manager.canStartNewJob()).toBe(true);
    });

    it('should block new jobs when at limit', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));
      manager.registerJob(createJob('job-2', { state: 'InProgress' }));
      manager.registerJob(createJob('job-3', { state: 'UploadComplete' }));

      expect(manager.canStartNewJob()).toBe(false);
    });

    it('should not count completed jobs toward the limit', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));
      manager.registerJob(createJob('job-2', { state: 'JobComplete' }));
      manager.registerJob(createJob('job-3', { state: 'Failed' }));

      expect(manager.canStartNewJob()).toBe(true);
    });
  });

  describe('removeJob', () => {
    it('should remove a tracked job', () => {
      manager.registerJob(createJob('job-1'));
      const result = manager.removeJob('job-1');

      expect(result).toBe(true);
      expect(manager.totalJobs).toBe(0);
    });

    it('should return false when job does not exist', () => {
      expect(manager.removeJob('nope')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all tracked jobs', () => {
      manager.registerJob(createJob('job-1'));
      manager.registerJob(createJob('job-2'));
      manager.clear();

      expect(manager.totalJobs).toBe(0);
    });
  });

  describe('purge completed jobs', () => {
    it('should auto-purge when completed jobs exceed 50', () => {
      const bigManager = new BulkApiManager(100);

      // Register 55 completed jobs
      for (let i = 0; i < 55; i++) {
        bigManager.registerJob(createJob(`job-${i}`, { state: 'InProgress' }));
      }

      // Complete all 55 by updating state — purge triggers on terminal state
      for (let i = 0; i < 55; i++) {
        bigManager.updateJobState(`job-${i}`, 'JobComplete');
      }

      // Should have purged down to 50 completed
      const completed = bigManager.getCompletedJobs();
      expect(completed.length).toBeLessThanOrEqual(50);
    });

    it('should not purge when completed jobs are at or below 50', () => {
      const bigManager = new BulkApiManager(100);

      for (let i = 0; i < 50; i++) {
        bigManager.registerJob(createJob(`job-${i}`, { state: 'InProgress' }));
        bigManager.updateJobState(`job-${i}`, 'JobComplete');
      }

      expect(bigManager.getCompletedJobs().length).toBe(50);
    });
  });

  describe('default max concurrent jobs', () => {
    it('should default to 5 concurrent jobs', () => {
      const defaultManager = new BulkApiManager();

      for (let i = 0; i < 5; i++) {
        defaultManager.registerJob(
          createJob(`job-${i}`, { state: 'InProgress' })
        );
      }

      expect(defaultManager.canStartNewJob()).toBe(false);
    });
  });
});
