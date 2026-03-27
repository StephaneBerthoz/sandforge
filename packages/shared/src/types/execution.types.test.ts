import { describe, it, expect } from 'vitest';
import type { ObjectProgress, BulkExecutionProgress, RetryStatus } from './execution.types';

describe('execution.types', () => {
  it('should allow creating an ObjectProgress', () => {
    const progress: ObjectProgress = {
      objectName: 'Account',
      jobId: 'job-001',
      operation: 'insert',
      recordsProcessed: 50,
      recordsFailed: 2,
      totalRecords: 100,
      state: 'processing',
      startedAt: Date.now(),
    };

    expect(progress.objectName).toBe('Account');
    expect(progress.state).toBe('processing');
  });

  it('should allow optional estimatedCompletionMs on ObjectProgress', () => {
    const progress: ObjectProgress = {
      objectName: 'Contact',
      jobId: 'job-002',
      operation: 'upsert',
      recordsProcessed: 100,
      recordsFailed: 0,
      totalRecords: 100,
      state: 'complete',
      startedAt: Date.now(),
      estimatedCompletionMs: 0,
    };

    expect(progress.estimatedCompletionMs).toBe(0);
  });

  it('should allow creating an ExecutionProgress', () => {
    const exec: BulkExecutionProgress = {
      executionId: 'exec-001',
      objects: [],
      overallPercent: 0,
      elapsedMs: 1000,
    };

    expect(exec.executionId).toBe('exec-001');
    expect(exec.objects).toHaveLength(0);
  });

  it('should allow creating a RetryStatus', () => {
    const status: RetryStatus = {
      executionId: 'exec-001',
      objectName: 'Account',
      attemptNumber: 2,
      maxAttempts: 5,
      nextRetryAt: Date.now() + 5000,
      lastError: 'UNABLE_TO_LOCK_ROW',
      canRetry: true,
      canAbort: true,
    };

    expect(status.attemptNumber).toBe(2);
    expect(status.canRetry).toBe(true);
  });

  it('should allow null nextRetryAt on RetryStatus', () => {
    const status: RetryStatus = {
      executionId: 'exec-001',
      objectName: 'Account',
      attemptNumber: 5,
      maxAttempts: 5,
      nextRetryAt: null,
      lastError: 'UNABLE_TO_LOCK_ROW',
      canRetry: false,
      canAbort: true,
    };

    expect(status.nextRetryAt).toBeNull();
    expect(status.canRetry).toBe(false);
  });
});
