import { describe, it, expect } from 'vitest';
import type {
  ObjectProgress,
  BulkExecutionProgress,
  RetryStatus,
  StreamingChunkResult,
  StreamingExecutionResult,
  BackgroundOperationStatus,
  ActiveOperation,
} from './execution.types';

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

  it('should allow optional chunk tracking fields on ObjectProgress', () => {
    const progress: ObjectProgress = {
      objectName: 'Account',
      jobId: 'job-003',
      operation: 'insert',
      recordsProcessed: 4000,
      recordsFailed: 0,
      totalRecords: 10000,
      state: 'processing',
      startedAt: Date.now(),
      chunksProcessed: 2,
      totalChunks: 5,
    };

    expect(progress.chunksProcessed).toBe(2);
    expect(progress.totalChunks).toBe(5);
  });

  it('should allow ObjectProgress without chunk fields (backward compatible)', () => {
    const progress: ObjectProgress = {
      objectName: 'Lead',
      jobId: 'job-004',
      operation: 'update',
      recordsProcessed: 100,
      recordsFailed: 0,
      totalRecords: 100,
      state: 'complete',
      startedAt: Date.now(),
    };

    expect(progress.chunksProcessed).toBeUndefined();
    expect(progress.totalChunks).toBeUndefined();
  });

  it('should allow creating a StreamingChunkResult', () => {
    const result: StreamingChunkResult = {
      successCount: 1990,
      failureCount: 10,
      successIds: ['001xx0000001', '001xx0000002'],
      errors: ['DUPLICATE_VALUE: duplicate'],
    };

    expect(result.successCount).toBe(1990);
    expect(result.failureCount).toBe(10);
    expect(result.successIds).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
  });

  it('should allow creating a StreamingExecutionResult', () => {
    const result: StreamingExecutionResult = {
      totalRecords: 10000,
      successCount: 9800,
      failureCount: 200,
      successIds: [],
      errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'],
      aborted: false,
    };

    expect(result.totalRecords).toBe(10000);
    expect(result.aborted).toBe(false);
  });

  it('should allow StreamingExecutionResult with aborted flag', () => {
    const result: StreamingExecutionResult = {
      totalRecords: 4000,
      successCount: 4000,
      failureCount: 0,
      successIds: [],
      errors: [],
      aborted: true,
    };

    expect(result.aborted).toBe(true);
  });

  it('should allow BackgroundOperationStatus values', () => {
    const statuses: BackgroundOperationStatus[] = ['running', 'completed', 'failed', 'aborted'];

    expect(statuses).toHaveLength(4);
    expect(statuses).toContain('running');
    expect(statuses).toContain('aborted');
  });

  it('should allow creating an ActiveOperation with required fields', () => {
    const op: ActiveOperation = {
      operationId: 'op-001',
      module: 'sync',
      description: 'Syncing Account records',
      status: 'running',
      progressPercent: 45,
      startedAt: Date.now(),
    };

    expect(op.operationId).toBe('op-001');
    expect(op.status).toBe('running');
    expect(op.completedAt).toBeUndefined();
    expect(op.resultSummary).toBeUndefined();
  });

  it('should allow creating a completed ActiveOperation with optional fields', () => {
    const now = Date.now();
    const op: ActiveOperation = {
      operationId: 'op-002',
      module: 'seed',
      description: 'Seeding Contact records',
      status: 'completed',
      progressPercent: 100,
      startedAt: now - 60000,
      completedAt: now,
      resultSummary: '45,230 records processed',
    };

    expect(op.completedAt).toBe(now);
    expect(op.resultSummary).toBe('45,230 records processed');
  });
});
