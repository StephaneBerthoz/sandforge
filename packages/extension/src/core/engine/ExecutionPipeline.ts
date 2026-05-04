import type { PipelineStatus, StepStatus, ExecutionProgress } from '@sandforge/shared';
import { logger } from '../../logger.js';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

/** A single step in the execution pipeline */
export interface PipelineStep {
  id: string;
  name: string;
  objectApiName: string;
  status: StepStatus;
  recordCount: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
}

/** Pipeline event types */
export type PipelineEventType =
  | 'statusChanged'
  | 'stepStarted'
  | 'stepCompleted'
  | 'stepFailed'
  | 'progressUpdated';

/** Event emitted by the pipeline during execution */
export interface PipelineEvent {
  type: PipelineEventType;
  pipelineId: string;
  stepId?: string;
  status?: PipelineStatus;
  progress?: ExecutionProgress;
}

/** Listener callback for pipeline events */
export type PipelineListener = (event: PipelineEvent) => void;

/**
 * Manages step-by-step execution of data operations.
 * Supports start, pause, resume, cancel, and tracks progress across all steps.
 */
export class ExecutionPipeline {
  private readonly pipelineId: string;
  private status: PipelineStatus = 'idle';
  private steps: PipelineStep[] = [];
  private currentStepIndex = -1;
  private startTime = 0;
  private listeners: Set<PipelineListener> = new Set();

  constructor(id: string) {
    this.pipelineId = id;
  }

  /** Get the pipeline identifier */
  getId(): string {
    return this.pipelineId;
  }

  /** Get the current pipeline status */
  getStatus(): PipelineStatus {
    return this.status;
  }

  /** Get a copy of all steps */
  getSteps(): PipelineStep[] {
    return [...this.steps];
  }

  /** Get the index of the currently executing step */
  getCurrentStepIndex(): number {
    return this.currentStepIndex;
  }

  /** Add a step to the pipeline */
  addStep(step: PipelineStep): void {
    if (this.status !== 'idle') {
      throw new Error('Cannot add steps to a pipeline that has already started');
    }
    this.steps.push(step);
  }

  /** Register an event listener */
  onEvent(listener: PipelineListener): void {
    this.listeners.add(listener);
  }

  /** Remove an event listener */
  offEvent(listener: PipelineListener): void {
    this.listeners.delete(listener);
  }

  /** Start the pipeline execution */
  start(): void {
    this.status = 'running';
    this.startTime = Date.now();
    this.currentStepIndex = 0;
    this.emit({
      type: 'statusChanged',
      pipelineId: this.pipelineId,
      status: this.status,
    });
  }

  /** Mark the current step as completed and advance to the next */
  completeCurrentStep(counts?: { processed: number; success: number; failure: number }): boolean {
    if (this.currentStepIndex < 0 || this.currentStepIndex >= this.steps.length) {
      return false;
    }

    const step = this.steps[this.currentStepIndex];
    step.status = 'completed';
    if (counts) {
      step.processedCount = counts.processed;
      step.successCount = counts.success;
      step.failureCount = counts.failure;
    } else {
      step.processedCount = step.recordCount;
      step.successCount = step.recordCount;
    }
    this.emit({
      type: 'stepCompleted',
      pipelineId: this.pipelineId,
      stepId: step.id,
    });

    this.currentStepIndex++;

    if (this.currentStepIndex >= this.steps.length) {
      this.status = 'completed';
      this.emit({
        type: 'statusChanged',
        pipelineId: this.pipelineId,
        status: this.status,
      });
    }

    return true;
  }

  /** Mark the current step as failed and halt the pipeline */
  failCurrentStep(_error: string): boolean {
    if (this.currentStepIndex < 0 || this.currentStepIndex >= this.steps.length) {
      return false;
    }

    const step = this.steps[this.currentStepIndex];
    step.status = 'failed';
    this.status = 'failed';
    this.emit({
      type: 'stepFailed',
      pipelineId: this.pipelineId,
      stepId: step.id,
    });
    this.emit({
      type: 'statusChanged',
      pipelineId: this.pipelineId,
      status: this.status,
    });

    return true;
  }

  /** Pause a running pipeline */
  pause(): void {
    if (this.status === 'running') {
      this.status = 'paused';
      this.emit({
        type: 'statusChanged',
        pipelineId: this.pipelineId,
        status: this.status,
      });
    }
  }

  /** Resume a paused pipeline */
  resume(): void {
    if (this.status === 'paused') {
      this.status = 'running';
      this.emit({
        type: 'statusChanged',
        pipelineId: this.pipelineId,
        status: this.status,
      });
    }
  }

  /** Cancel the pipeline */
  cancel(): void {
    this.status = 'cancelled';
    this.emit({
      type: 'statusChanged',
      pipelineId: this.pipelineId,
      status: this.status,
    });
  }

  /** Compute aggregate execution progress across all steps */
  getProgress(): ExecutionProgress {
    const totalRecords = this.steps.reduce((sum, s) => sum + s.recordCount, 0);
    const processedRecords = this.steps.reduce((sum, s) => sum + s.processedCount, 0);
    const successRecords = this.steps.reduce((sum, s) => sum + s.successCount, 0);
    const failedRecords = this.steps.reduce((sum, s) => sum + s.failureCount, 0);
    const elapsed = this.startTime > 0 ? Date.now() - this.startTime : 0;
    const rate = elapsed > 0 ? (processedRecords / elapsed) * 1000 : 0;
    const now = new Date().toISOString();

    return {
      totalSteps: this.steps.length,
      completedSteps: this.steps.filter((s) => s.status === 'completed').length,
      currentStepIndex: this.currentStepIndex,
      totalRecords,
      processedRecords,
      successRecords,
      failedRecords,
      startTime: this.startTime > 0 ? new Date(this.startTime).toISOString() : now,
      elapsedMs: elapsed,
      recordsPerSecond: rate,
    };
  }

  /** Dispose all listeners */
  dispose(): void {
    this.listeners.clear();
  }

  private emit(event: PipelineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn('ExecutionPipeline listener threw', {
          error: extractErrorMessage(err),
        });
      }
    }
  }
}
