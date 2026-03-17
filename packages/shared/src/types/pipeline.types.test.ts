import { describe, it, expect } from 'vitest';

import type {
  ExecutionPipeline,
  ExecutionStep,
  PipelineOptions,
  ExecutionProgress,
} from './pipeline.types.js';

describe('ExecutionStep', () => {
  function createStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
    return {
      id: 'step-0001-uuid',
      name: 'Insert Accounts',
      objectApiName: 'Account',
      operation: 'insert',
      status: 'pending',
      recordCount: 500,
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      retryCount: 0,
      ...overrides,
    };
  }

  it('should create a pending step with zero progress', () => {
    const step = createStep();

    expect(step.id).toBe('step-0001-uuid');
    expect(step.name).toBe('Insert Accounts');
    expect(step.objectApiName).toBe('Account');
    expect(step.operation).toBe('insert');
    expect(step.status).toBe('pending');
    expect(step.processedCount).toBe(0);
    expect(step.startTime).toBeUndefined();
    expect(step.endTime).toBeUndefined();
    expect(step.error).toBeUndefined();
  });

  it('should represent a completed step with timing and counts', () => {
    const step = createStep({
      status: 'completed',
      processedCount: 500,
      successCount: 498,
      failureCount: 2,
      startTime: '2026-02-20T10:00:00.000Z',
      endTime: '2026-02-20T10:00:45.000Z',
    });

    expect(step.status).toBe('completed');
    expect(step.successCount + step.failureCount).toBe(step.processedCount);
    expect(step.startTime).toBeDefined();
    expect(step.endTime).toBeDefined();
  });

  it('should represent a failed step with error and retry count', () => {
    const step = createStep({
      status: 'failed',
      processedCount: 120,
      successCount: 120,
      failureCount: 0,
      retryCount: 3,
      error: 'REQUEST_LIMIT_EXCEEDED: API limit reached',
    });

    expect(step.status).toBe('failed');
    expect(step.retryCount).toBe(3);
    expect(step.error).toContain('REQUEST_LIMIT_EXCEEDED');
  });
});

describe('PipelineOptions', () => {
  function createOptions(
    overrides: Partial<PipelineOptions> = {},
  ): PipelineOptions {
    return {
      apiMode: 'auto',
      grappeMode: false,
      parallelism: 1,
      batchSize: 200,
      errorHandling: 'continue_and_report',
      enableRollback: true,
      dryRun: false,
      checkpoint: true,
      ...overrides,
    };
  }

  it('should create default options with sensible defaults', () => {
    const options = createOptions();

    expect(options.apiMode).toBe('auto');
    expect(options.grappeMode).toBe(false);
    expect(options.parallelism).toBe(1);
    expect(options.batchSize).toBe(200);
    expect(options.errorHandling).toBe('continue_and_report');
    expect(options.enableRollback).toBe(true);
    expect(options.dryRun).toBe(false);
    expect(options.checkpoint).toBe(true);
    expect(options.preScript).toBeUndefined();
    expect(options.postScript).toBeUndefined();
  });

  it('should support bulk mode with grappe and custom scripts', () => {
    const options = createOptions({
      apiMode: 'bulk',
      grappeMode: true,
      parallelism: 4,
      batchSize: 10000,
      preScript: 'SELECT Id FROM Account LIMIT 1',
      postScript: 'SELECT count() FROM Account',
    });

    expect(options.apiMode).toBe('bulk');
    expect(options.grappeMode).toBe(true);
    expect(options.parallelism).toBe(4);
    expect(options.preScript).toBeDefined();
    expect(options.postScript).toBeDefined();
  });
});

describe('ExecutionPipeline', () => {
  it('should assemble a complete pipeline with steps and progress', () => {
    const progress: ExecutionProgress = {
      totalSteps: 3,
      completedSteps: 1,
      currentStepIndex: 1,
      totalRecords: 1500,
      processedRecords: 500,
      successRecords: 498,
      failedRecords: 2,
      startTime: '2026-02-20T10:00:00.000Z',
      elapsedMs: 45000,
      recordsPerSecond: 11.1,
    };

    const steps: ExecutionStep[] = [
      {
        id: 'step-001',
        name: 'Insert Accounts',
        objectApiName: 'Account',
        operation: 'insert',
        status: 'completed',
        recordCount: 500,
        processedCount: 500,
        successCount: 498,
        failureCount: 2,
        retryCount: 0,
        startTime: '2026-02-20T10:00:00.000Z',
        endTime: '2026-02-20T10:00:30.000Z',
      },
      {
        id: 'step-002',
        name: 'Insert Contacts',
        objectApiName: 'Contact',
        operation: 'insert',
        status: 'running',
        recordCount: 500,
        processedCount: 200,
        successCount: 200,
        failureCount: 0,
        retryCount: 0,
        startTime: '2026-02-20T10:00:30.000Z',
      },
      {
        id: 'step-003',
        name: 'Insert Opportunities',
        objectApiName: 'Opportunity',
        operation: 'insert',
        status: 'pending',
        recordCount: 500,
        processedCount: 0,
        successCount: 0,
        failureCount: 0,
        retryCount: 0,
      },
    ];

    const pipeline: ExecutionPipeline = {
      id: 'pipeline-uuid-001',
      status: 'running',
      steps,
      options: {
        apiMode: 'auto',
        grappeMode: false,
        parallelism: 1,
        batchSize: 200,
        errorHandling: 'continue_and_report',
        enableRollback: true,
        dryRun: false,
        checkpoint: true,
      },
      progress,
    };

    expect(pipeline.id).toBe('pipeline-uuid-001');
    expect(pipeline.status).toBe('running');
    expect(pipeline.steps).toHaveLength(3);
    expect(pipeline.progress.completedSteps).toBe(1);
    expect(pipeline.progress.totalRecords).toBe(1500);
    expect(pipeline.result).toBeUndefined();
  });

  it('should include an optional result when pipeline completes', () => {
    const pipeline: ExecutionPipeline = {
      id: 'pipeline-uuid-002',
      status: 'completed',
      steps: [],
      options: {
        apiMode: 'rest',
        grappeMode: false,
        parallelism: 1,
        batchSize: 200,
        errorHandling: 'stop_on_first',
        enableRollback: false,
        dryRun: true,
        checkpoint: false,
      },
      progress: {
        totalSteps: 0,
        completedSteps: 0,
        currentStepIndex: 0,
        totalRecords: 0,
        processedRecords: 0,
        successRecords: 0,
        failedRecords: 0,
        startTime: '2026-02-20T10:00:00.000Z',
        elapsedMs: 100,
        recordsPerSecond: 0,
      },
      result: {
        success: true,
        warnings: [],
        duration: 100,
        timestamp: '2026-02-20T10:00:00.100Z',
      },
    };

    expect(pipeline.status).toBe('completed');
    expect(pipeline.result).toBeDefined();
    expect(pipeline.result!.success).toBe(true);
  });
});
