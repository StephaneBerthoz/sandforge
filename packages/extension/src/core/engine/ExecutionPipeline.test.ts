import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutionPipeline } from './ExecutionPipeline';
import type { PipelineStep, PipelineEvent } from './ExecutionPipeline';

function createStep(id: string, recordCount: number = 100): PipelineStep {
  return {
    id,
    name: `Step ${id}`,
    objectApiName: `Object_${id}__c`,
    status: 'pending',
    recordCount,
    processedCount: 0,
    successCount: 0,
    failureCount: 0,
  };
}

describe('ExecutionPipeline', () => {
  let pipeline: ExecutionPipeline;

  beforeEach(() => {
    vi.useFakeTimers();
    pipeline = new ExecutionPipeline('test-pipeline-1');
  });

  afterEach(() => {
    pipeline.dispose();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should have the correct ID', () => {
      expect(pipeline.getId()).toBe('test-pipeline-1');
    });

    it('should start in idle status', () => {
      expect(pipeline.getStatus()).toBe('idle');
    });

    it('should have no steps initially', () => {
      expect(pipeline.getSteps()).toEqual([]);
    });

    it('should have current step index of -1 before start', () => {
      expect(pipeline.getCurrentStepIndex()).toBe(-1);
    });
  });

  describe('addStep', () => {
    it('should add steps to the pipeline', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.addStep(createStep('s2'));

      expect(pipeline.getSteps()).toHaveLength(2);
    });

    it('should reject addStep after pipeline has started', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.start();

      expect(() => pipeline.addStep(createStep('s2'))).toThrow(
        'Cannot add steps to a pipeline that has already started',
      );
    });

    it('should return copies of steps', () => {
      pipeline.addStep(createStep('s1'));
      const steps = pipeline.getSteps();
      steps.pop();

      expect(pipeline.getSteps()).toHaveLength(1);
    });
  });

  describe('start', () => {
    it('should set status to running', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.start();

      expect(pipeline.getStatus()).toBe('running');
    });

    it('should set current step index to 0', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.start();

      expect(pipeline.getCurrentStepIndex()).toBe(0);
    });

    it('should emit a statusChanged event', () => {
      const events: PipelineEvent[] = [];
      pipeline.onEvent((e) => events.push(e));
      pipeline.addStep(createStep('s1'));
      pipeline.start();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('statusChanged');
      expect(events[0].status).toBe('running');
    });
  });

  describe('completeCurrentStep', () => {
    it('should advance to the next step', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.addStep(createStep('s2'));
      pipeline.start();
      pipeline.completeCurrentStep();

      expect(pipeline.getCurrentStepIndex()).toBe(1);
    });

    it('should mark the step as completed with correct counts', () => {
      pipeline.addStep(createStep('s1', 50));
      pipeline.start();
      pipeline.completeCurrentStep();

      const steps = pipeline.getSteps();
      expect(steps[0].status).toBe('completed');
      expect(steps[0].processedCount).toBe(50);
      expect(steps[0].successCount).toBe(50);
    });

    it('should accept custom counts when provided', () => {
      pipeline.addStep(createStep('s1', 100));
      pipeline.start();
      pipeline.completeCurrentStep({ processed: 90, success: 80, failure: 10 });

      const steps = pipeline.getSteps();
      expect(steps[0].processedCount).toBe(90);
      expect(steps[0].successCount).toBe(80);
      expect(steps[0].failureCount).toBe(10);
    });

    it('should set pipeline to completed when all steps are done', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.start();
      pipeline.completeCurrentStep();

      expect(pipeline.getStatus()).toBe('completed');
    });

    it('should emit stepCompleted and statusChanged events', () => {
      const events: PipelineEvent[] = [];
      pipeline.onEvent((e) => events.push(e));
      pipeline.addStep(createStep('s1'));
      pipeline.start();
      pipeline.completeCurrentStep();

      const types = events.map((e) => e.type);
      expect(types).toContain('stepCompleted');
      expect(types.filter((t) => t === 'statusChanged')).toHaveLength(2);
    });

    it('should return false when no step is active', () => {
      expect(pipeline.completeCurrentStep()).toBe(false);
    });
  });

  describe('failCurrentStep', () => {
    it('should mark step and pipeline as failed', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.start();
      pipeline.failCurrentStep('something broke');

      expect(pipeline.getSteps()[0].status).toBe('failed');
      expect(pipeline.getStatus()).toBe('failed');
    });

    it('should emit stepFailed and statusChanged events', () => {
      const events: PipelineEvent[] = [];
      pipeline.onEvent((e) => events.push(e));
      pipeline.addStep(createStep('s1'));
      pipeline.start();
      pipeline.failCurrentStep('oops');

      const types = events.map((e) => e.type);
      expect(types).toContain('stepFailed');
      expect(types).toContain('statusChanged');
    });

    it('should return false when no step is active', () => {
      expect(pipeline.failCurrentStep('err')).toBe(false);
    });
  });

  describe('pause and resume', () => {
    it('should pause a running pipeline', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.start();
      pipeline.pause();

      expect(pipeline.getStatus()).toBe('paused');
    });

    it('should resume a paused pipeline', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.start();
      pipeline.pause();
      pipeline.resume();

      expect(pipeline.getStatus()).toBe('running');
    });

    it('should not pause a non-running pipeline', () => {
      pipeline.pause();
      expect(pipeline.getStatus()).toBe('idle');
    });

    it('should not resume a non-paused pipeline', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.start();
      pipeline.resume();

      expect(pipeline.getStatus()).toBe('running');
    });
  });

  describe('cancel', () => {
    it('should set status to cancelled', () => {
      pipeline.addStep(createStep('s1'));
      pipeline.start();
      pipeline.cancel();

      expect(pipeline.getStatus()).toBe('cancelled');
    });

    it('should emit a statusChanged event', () => {
      const events: PipelineEvent[] = [];
      pipeline.onEvent((e) => events.push(e));
      pipeline.cancel();

      expect(events[0].type).toBe('statusChanged');
      expect(events[0].status).toBe('cancelled');
    });
  });

  describe('getProgress', () => {
    it('should compute aggregate progress across all steps', () => {
      pipeline.addStep(createStep('s1', 100));
      pipeline.addStep(createStep('s2', 200));
      pipeline.start();
      vi.advanceTimersByTime(1000);
      pipeline.completeCurrentStep();

      const progress = pipeline.getProgress();

      expect(progress.totalSteps).toBe(2);
      expect(progress.completedSteps).toBe(1);
      expect(progress.totalRecords).toBe(300);
      expect(progress.processedRecords).toBe(100);
      expect(progress.successRecords).toBe(100);
      expect(progress.failedRecords).toBe(0);
      expect(progress.elapsedMs).toBe(1000);
      expect(progress.recordsPerSecond).toBe(100);
    });

    it('should return zero elapsed when pipeline has not started', () => {
      pipeline.addStep(createStep('s1'));
      const progress = pipeline.getProgress();

      expect(progress.elapsedMs).toBe(0);
      expect(progress.recordsPerSecond).toBe(0);
    });
  });

  describe('event listener management', () => {
    it('should support adding and removing listeners', () => {
      const events: PipelineEvent[] = [];
      const listener = (e: PipelineEvent): void => {
        events.push(e);
      };

      pipeline.onEvent(listener);
      pipeline.cancel();
      expect(events).toHaveLength(1);

      pipeline.offEvent(listener);
      pipeline.cancel();
      expect(events).toHaveLength(1);
    });

    it('should continue notifying listeners even if one throws', () => {
      const throwing = vi.fn(() => {
        throw new Error('boom');
      });
      const safe = vi.fn();
      pipeline.onEvent(throwing);
      pipeline.onEvent(safe);

      pipeline.cancel();

      expect(throwing).toHaveBeenCalledTimes(1);
      expect(safe).toHaveBeenCalledTimes(1);
    });

    it('should clear all listeners on dispose', () => {
      const events: PipelineEvent[] = [];
      pipeline.onEvent((e) => events.push(e));
      pipeline.dispose();
      pipeline.cancel();

      expect(events).toHaveLength(0);
    });
  });
});
