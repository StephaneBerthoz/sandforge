import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StepExecutor } from './StepExecutor';
import type { StepContext } from './StepExecutor';
import type { PipelineStep } from '@sandforge/shared';

function createStep(overrides?: Partial<PipelineStep>): PipelineStep {
  return {
    id: 'step-1',
    name: 'Test Step',
    type: 'seed',
    config: {},
    continueOnError: false,
    ...overrides,
  };
}

function createContext(overrides?: Partial<StepContext>): StepContext {
  return {
    variables: {},
    previousResults: [],
    pipelineId: 'pipeline-1',
    runId: 'run-1',
    ...overrides,
  };
}

describe('StepExecutor', () => {
  let executor: StepExecutor;

  beforeEach(() => {
    vi.useFakeTimers();
    executor = new StepExecutor();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('execute', () => {
    it('should execute a step and return a completed result', async () => {
      const step = createStep({ type: 'seed' });
      const context = createContext();

      const result = await executor.execute(step, context);

      expect(result.status).toBe('completed');
      expect(result.stepId).toBe('step-1');
      expect(result.stepName).toBe('Test Step');
      expect(result.stepType).toBe('seed');
    });

    it('should handle the delay step by waiting the configured duration', async () => {
      const step = createStep({ type: 'delay', config: { durationMs: 500 } });
      const context = createContext();

      const promise = executor.execute(step, context);
      vi.advanceTimersByTime(500);
      const result = await promise;

      expect(result.status).toBe('completed');
      expect(result.output).toEqual({ delayed: 500 });
    });

    it('should handle the condition step with a matching condition', async () => {
      const step = createStep({
        type: 'condition',
        condition: { field: 'env', operator: 'eq', value: 'production' },
      });
      const context = createContext({ variables: { env: 'production' } });

      const result = await executor.execute(step, context);

      expect(result.status).toBe('completed');
      expect(result.output).toEqual({ conditionMet: true });
    });

    it('should handle the condition step with a non-matching condition', async () => {
      const step = createStep({
        type: 'condition',
        condition: { field: 'env', operator: 'eq', value: 'production' },
      });
      const context = createContext({ variables: { env: 'sandbox' } });

      const result = await executor.execute(step, context);

      expect(result.status).toBe('completed');
      expect(result.output).toEqual({ conditionMet: false });
    });

    it('should return completed for condition step without condition', async () => {
      const step = createStep({ type: 'condition' });
      const context = createContext();

      const result = await executor.execute(step, context);

      expect(result.status).toBe('completed');
      expect(result.output).toEqual({ conditionMet: true });
    });

    it('should return failure result when handler throws', async () => {
      executor.registerHandler('seed', async () => {
        throw new Error('Seed failed');
      });

      const step = createStep({ type: 'seed' });
      const context = createContext();

      const result = await executor.execute(step, context);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Seed failed');
    });

    it('should retry on failure up to the configured retries count', async () => {
      let attempts = 0;
      executor.registerHandler('seed', async (s) => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Transient error');
        }
        return {
          stepId: s.id,
          stepName: s.name,
          stepType: s.type,
          status: 'completed',
          startTime: new Date().toISOString(),
        };
      });

      const step = createStep({ type: 'seed', retries: 3 });
      const context = createContext();

      const result = await executor.execute(step, context);

      expect(result.status).toBe('completed');
      expect(attempts).toBe(3);
    });
  });

  describe('getExecutor', () => {
    it('should return a registered handler for known types', () => {
      const handler = executor.getExecutor('seed');
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    it('should return a fallback handler for unregistered types', () => {
      const handler = executor.getExecutor('unknown_type' as never);
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });
  });

  describe('registerHandler', () => {
    it('should allow registering a custom handler', async () => {
      const customHandler = vi.fn().mockResolvedValue({
        stepId: 'step-1',
        stepName: 'Custom',
        stepType: 'seed',
        status: 'completed',
      });

      executor.registerHandler('seed', customHandler);
      const step = createStep({ type: 'seed' });
      const context = createContext();

      await executor.execute(step, context);

      expect(customHandler).toHaveBeenCalledTimes(1);
      expect(customHandler).toHaveBeenCalledWith(step, context);
    });
  });
});
