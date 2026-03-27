import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BulkJobProgressTracker } from './BulkJobProgressTracker';
import { BulkApiManager } from './BulkApiManager';
import type { BulkJobInfo } from './BulkApiManager';


function createJob(id: string, overrides?: Partial<BulkJobInfo>): BulkJobInfo {
  return {
    id,
    operation: 'insert',
    object: 'Account',
    state: 'UploadComplete',
    numberRecordsProcessed: 0,
    numberRecordsFailed: 0,
    totalProcessingTime: 0,
    createdDate: '2026-03-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('BulkJobProgressTracker', () => {
  let manager: BulkApiManager;
  let tracker: BulkJobProgressTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new BulkApiManager();
    tracker = new BulkJobProgressTracker(manager, 1000);
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  describe('startTracking', () => {
    it('should emit an initial progress snapshot immediately', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));

      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);

      expect(callback).toHaveBeenCalledOnce();
      const progress: BulkExecutionProgress = callback.mock.calls[0][0];
      expect(progress.executionId).toBe('exec-1');
      expect(progress.objects).toHaveLength(1);
      expect(progress.objects[0].objectName).toBe('Account');
    });

    it('should replace existing tracking for the same executionId', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));
      manager.registerJob(createJob('job-2', { state: 'InProgress' }));

      const callback = vi.fn();
      tracker.onProgress(callback);

      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);

      tracker.startTracking('exec-1', [
        { jobId: 'job-2', objectName: 'Contact', totalRecords: 200 },
      ]);

      // Clear initial calls and advance timer
      callback.mockClear();
      vi.advanceTimersByTime(1000);

      expect(callback).toHaveBeenCalledOnce();
      const progress: BulkExecutionProgress = callback.mock.calls[0][0];
      expect(progress.objects[0].objectName).toBe('Contact');
    });
  });

  describe('progress emission', () => {
    it('should emit progress with correct per-object data', () => {
      manager.registerJob(createJob('job-1', {
        state: 'InProgress',
        operation: 'insert',
        numberRecordsProcessed: 50,
        numberRecordsFailed: 2,
      }));

      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);

      const progress: BulkExecutionProgress = callback.mock.calls[0][0];
      expect(progress.objects[0].recordsProcessed).toBe(50);
      expect(progress.objects[0].recordsFailed).toBe(2);
      expect(progress.objects[0].state).toBe('processing');
      expect(progress.objects[0].operation).toBe('insert');
    });

    it('should emit updated progress on each poll interval', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));

      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);

      // Update job and advance timer
      manager.updateJobCounts('job-1', 75, 0);
      vi.advanceTimersByTime(1000);

      expect(callback).toHaveBeenCalledTimes(2);
      const secondProgress: BulkExecutionProgress = callback.mock.calls[1][0];
      expect(secondProgress.objects[0].recordsProcessed).toBe(75);
    });

    it('should handle unknown jobs gracefully', () => {
      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'nonexistent', objectName: 'Lead', totalRecords: 50 },
      ]);

      const progress: BulkExecutionProgress = callback.mock.calls[0][0];
      expect(progress.objects[0].state).toBe('queued');
      expect(progress.objects[0].operation).toBe('unknown');
    });
  });

  describe('weighted percentage calculation', () => {
    it('should compute weighted average based on totalRecords', () => {
      manager.registerJob(createJob('job-1', {
        state: 'InProgress',
        numberRecordsProcessed: 100,
      }));
      manager.registerJob(createJob('job-2', {
        state: 'InProgress',
        object: 'Contact',
        numberRecordsProcessed: 50,
      }));

      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 200 },
        { jobId: 'job-2', objectName: 'Contact', totalRecords: 100 },
      ]);

      const progress: BulkExecutionProgress = callback.mock.calls[0][0];
      // (100 + 50) / (200 + 100) = 150/300 = 50%
      expect(progress.overallPercent).toBe(50);
    });

    it('should return 0 when totalRecords is 0', () => {
      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 0 },
      ]);

      const progress: BulkExecutionProgress = callback.mock.calls[0][0];
      expect(progress.overallPercent).toBe(0);
    });
  });

  describe('auto-stop on terminal state', () => {
    it('should auto-stop tracking when all jobs are terminal', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));

      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);

      // Complete the job
      manager.updateJobState('job-1', 'JobComplete');
      manager.updateJobCounts('job-1', 100, 0);
      vi.advanceTimersByTime(1000);

      // Further polls should not emit since tracking stopped
      callback.mockClear();
      vi.advanceTimersByTime(5000);
      expect(callback).not.toHaveBeenCalled();
    });

    it('should map Failed state correctly', () => {
      manager.registerJob(createJob('job-1', { state: 'Failed' }));

      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);

      const progress: BulkExecutionProgress = callback.mock.calls[0][0];
      expect(progress.objects[0].state).toBe('failed');
    });

    it('should map Aborted state correctly', () => {
      manager.registerJob(createJob('job-1', { state: 'Aborted' }));

      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);

      const progress: BulkExecutionProgress = callback.mock.calls[0][0];
      expect(progress.objects[0].state).toBe('aborted');
    });
  });

  describe('stopTracking', () => {
    it('should stop emitting after stopTracking is called', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));

      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);

      tracker.stopTracking('exec-1');
      callback.mockClear();
      vi.advanceTimersByTime(5000);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should be safe to call for non-existent executionId', () => {
      expect(() => tracker.stopTracking('nonexistent')).not.toThrow();
    });
  });

  describe('onProgress unsubscribe', () => {
    it('should not call callback after unsubscribe', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));

      const callback = vi.fn();
      const unsubscribe = tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);

      unsubscribe();
      callback.mockClear();
      vi.advanceTimersByTime(1000);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should clear all intervals and state', () => {
      manager.registerJob(createJob('job-1', { state: 'InProgress' }));
      manager.registerJob(createJob('job-2', { state: 'InProgress' }));

      const callback = vi.fn();
      tracker.onProgress(callback);
      tracker.startTracking('exec-1', [
        { jobId: 'job-1', objectName: 'Account', totalRecords: 100 },
      ]);
      tracker.startTracking('exec-2', [
        { jobId: 'job-2', objectName: 'Contact', totalRecords: 200 },
      ]);

      tracker.dispose();
      callback.mockClear();
      vi.advanceTimersByTime(5000);

      expect(callback).not.toHaveBeenCalled();
    });
  });
});
