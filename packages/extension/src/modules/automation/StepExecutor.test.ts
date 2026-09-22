import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StepExecutor } from './StepExecutor';
import type { StepContext } from './StepExecutor';
import type { PipelineStep, PipelineStepType } from '@sandforge/shared';

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

/**
 * The thirteen step types no handler runs. Each of them used to go to a
 * pass-through that answered "completed" without doing anything.
 */
const UNRUNNABLE_TYPES: PipelineStepType[] = [
  'seed',
  'sync',
  'backup',
  'restore',
  'anonymize',
  'delete',
  'compare',
  'precheck',
  'script',
  'notification',
  'approval',
  'loop',
  'parallel',
];

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
    it.each(UNRUNNABLE_TYPES)('refuses a %s step instead of reporting it done', async (type) => {
      const step = createStep({ type, name: 'Load Accounts' });

      const result = await executor.execute(step, createContext());

      expect(result.status).toBe('failed');
      expect(result.error).toBe(
        `Step "Load Accounts" is a ${type} step, and this step type cannot run in a pipeline yet.`,
      );
      expect(result.output).toBeUndefined();
      expect(result.stepId).toBe('step-1');
      expect(result.stepType).toBe(type);
    });

    it('refuses a step type outside the union, as the AI draft and the predefined templates name them', async () => {
      for (const type of ['dataops', 'dataops:backup', 'monitor:refresh']) {
        const result = await executor.execute(
          createStep({ type: type as PipelineStepType }),
          createContext(),
        );
        expect(result.status).toBe('failed');
        expect(result.error).toContain('cannot run in a pipeline yet');
      }
    });

    it('refuses a step it cannot run at once, however many retries it is given', async () => {
      const result = await executor.execute(
        createStep({ type: 'backup', retries: 3, timeout: 1_000 }),
        createContext(),
      );

      expect(result.status).toBe('failed');
      expect(vi.getTimerCount()).toBe(0);
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

    it('waits the seconds the Step Config Panel writes, not 0 ms', async () => {
      // The panel stores `seconds`; the handler used to read only `durationMs`,
      // so every delay set in the UI waited nothing and reported the wait done.
      let settled = false;
      const promise = executor
        .execute(createStep({ type: 'delay', config: { seconds: 2 } }), createContext())
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;
      expect(result.status).toBe('completed');
      expect(result.output).toEqual({ delayed: 2_000 });
    });

    it('waits 0 seconds when that is what the step asks for', async () => {
      const promise = executor.execute(
        createStep({ type: 'delay', config: { seconds: 0 } }),
        createContext(),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect((await promise).output).toEqual({ delayed: 0 });
    });

    it('refuses a Delay step with no duration instead of calling a 0 ms wait done', async () => {
      const result = await executor.execute(
        createStep({ type: 'delay', name: 'Pause', config: {} }),
        createContext(),
      );

      expect(result.status).toBe('failed');
      expect(result.error).toBe(
        'Delay step "Pause" has no duration: set how many seconds it waits.',
      );
    });

    it.each([
      ['a negative number of seconds', { seconds: -5 }],
      ['seconds that are not a number', { seconds: '10' }],
      ['seconds that are not finite', { seconds: Number.POSITIVE_INFINITY }],
      ['seconds left empty', { seconds: null }],
      ['a wait longer than a timer can hold', { seconds: 25 * 24 * 60 * 60 }],
      ['a negative durationMs', { durationMs: -1 }],
    ])('refuses a Delay step with %s', async (_label, config) => {
      const result = await executor.execute(
        createStep({ type: 'delay', name: 'Pause', config }),
        createContext(),
      );

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Delay step "Pause" has no usable duration');
    });

    it('stops waiting when the run is aborted, and reports the wait unfinished', async () => {
      const aborter = new AbortController();
      let settled = false;
      const promise = executor
        .execute(
          createStep({ type: 'delay', name: 'Pause', config: { seconds: 60 } }),
          createContext({ signal: aborter.signal }),
        )
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(1_000);
      aborter.abort();
      await vi.advanceTimersByTimeAsync(0);

      // Settled with 59 s of the wait still on the clock.
      expect(settled).toBe(true);
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Delay step "Pause" was stopped before its 60000 ms wait ended.');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not start waiting when the run was aborted before the step', async () => {
      const aborter = new AbortController();
      aborter.abort();

      const result = await executor.execute(
        createStep({ type: 'delay', config: { seconds: 60 } }),
        createContext({ signal: aborter.signal }),
      );

      expect(result.status).toBe('failed');
      expect(vi.getTimerCount()).toBe(0);
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

    it('refuses a Condition step with no condition instead of reporting it met', async () => {
      // What the palette adds: nothing on the page sets a step's condition.
      const result = await executor.execute(
        createStep({ type: 'condition', name: 'Gate' }),
        createContext(),
      );

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Condition step "Gate" has no condition to evaluate.');
      expect(result.output).toBeUndefined();
    });

    it('refuses a condition whose field is blank', async () => {
      const result = await executor.execute(
        createStep({
          type: 'condition',
          name: 'Gate',
          condition: { field: '  ', operator: 'is_empty', value: '' },
        }),
        createContext(),
      );

      expect(result.error).toBe('Condition step "Gate" has no condition to evaluate.');
    });

    it('refuses an operator no condition knows instead of answering false', async () => {
      // The Marketplace's threshold step is written with '>', which evaluated
      // to false and read as a real answer.
      const result = await executor.execute(
        createStep({
          type: 'condition',
          name: 'Gate',
          condition: {
            field: 'apiUsagePercent',
            operator: '>' as never,
            value: '80',
          },
        }),
        createContext({ variables: { apiUsagePercent: '95' } }),
      );

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Condition step "Gate" uses an unknown operator: >.');
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

  describe('check', () => {
    it('clears a configured Delay and a configured Condition', () => {
      expect(executor.check(createStep({ type: 'delay', config: { seconds: 5 } }))).toBeUndefined();
      expect(
        executor.check(
          createStep({
            type: 'condition',
            condition: { field: 'env', operator: 'eq', value: 'uat' },
          }),
        ),
      ).toBeUndefined();
    });

    it('gives the reason for every step type that has no handler', () => {
      for (const type of UNRUNNABLE_TYPES) {
        expect(executor.check(createStep({ type }))).toContain('cannot run in a pipeline yet');
      }
    });

    it('clears a step type once a handler is registered for it', () => {
      executor.registerHandler('seed', vi.fn());
      expect(executor.check(createStep({ type: 'seed' }))).toBeUndefined();
    });

    it('lets a handler registered in place of a built-in one read its own config', () => {
      executor.registerHandler('delay', vi.fn());
      expect(executor.check(createStep({ type: 'delay', config: {} }))).toBeUndefined();
    });
  });

  describe('getExecutor', () => {
    it('should return a registered handler for known types', () => {
      const handler = executor.getExecutor('delay');
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    it('hands out a handler that refuses a type with none of its own', async () => {
      const handler = executor.getExecutor('unknown_type' as never);

      const result = await handler(createStep({ type: 'sync' }), createContext());

      expect(result.status).toBe('failed');
      expect(result.error).toContain('cannot run in a pipeline yet');
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
