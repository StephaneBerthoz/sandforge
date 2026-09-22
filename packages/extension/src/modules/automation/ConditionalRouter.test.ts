import { describe, it, expect, beforeEach } from 'vitest';
import { ConditionalRouter } from './ConditionalRouter';
import type { PipelineCondition, PipelineStep, PipelineStepResult } from '@sandforge/shared';

function createStep(overrides?: Partial<PipelineStep>): PipelineStep {
  return {
    id: 'step-1',
    name: 'Test Step',
    type: 'condition',
    config: {},
    continueOnError: false,
    ...overrides,
  };
}

function createResult(overrides?: Partial<PipelineStepResult>): PipelineStepResult {
  return {
    stepId: 'step-1',
    stepName: 'Test Step',
    stepType: 'condition',
    status: 'completed',
    ...overrides,
  };
}

describe('ConditionalRouter', () => {
  let router: ConditionalRouter;

  beforeEach(() => {
    router = new ConditionalRouter();
  });

  describe('evaluate', () => {
    it('should evaluate eq operator correctly', () => {
      const condition: PipelineCondition = { field: 'env', operator: 'eq', value: 'prod' };
      expect(router.evaluate(condition, { env: 'prod' })).toBe(true);
      expect(router.evaluate(condition, { env: 'dev' })).toBe(false);
    });

    it('should evaluate neq operator correctly', () => {
      const condition: PipelineCondition = { field: 'env', operator: 'neq', value: 'prod' };
      expect(router.evaluate(condition, { env: 'dev' })).toBe(true);
      expect(router.evaluate(condition, { env: 'prod' })).toBe(false);
    });

    it('should evaluate gt/gte/lt/lte operators numerically', () => {
      expect(router.evaluate({ field: 'count', operator: 'gt', value: 5 }, { count: 10 })).toBe(
        true,
      );
      expect(router.evaluate({ field: 'count', operator: 'gt', value: 5 }, { count: 3 })).toBe(
        false,
      );
      expect(router.evaluate({ field: 'count', operator: 'gte', value: 5 }, { count: 5 })).toBe(
        true,
      );
      expect(router.evaluate({ field: 'count', operator: 'lt', value: 5 }, { count: 3 })).toBe(
        true,
      );
      expect(router.evaluate({ field: 'count', operator: 'lte', value: 5 }, { count: 5 })).toBe(
        true,
      );
    });

    it('should evaluate contains and not_contains operators', () => {
      const context = { name: 'hello world' };
      expect(
        router.evaluate({ field: 'name', operator: 'contains', value: 'world' }, context),
      ).toBe(true);
      expect(
        router.evaluate({ field: 'name', operator: 'not_contains', value: 'foo' }, context),
      ).toBe(true);
      expect(router.evaluate({ field: 'name', operator: 'contains', value: 'foo' }, context)).toBe(
        false,
      );
    });

    it('should evaluate matches operator with regex', () => {
      const condition: PipelineCondition = { field: 'email', operator: 'matches', value: '^test@' };
      expect(router.evaluate(condition, { email: 'test@example.com' })).toBe(true);
      expect(router.evaluate(condition, { email: 'user@example.com' })).toBe(false);
    });

    it('should evaluate is_empty and is_not_empty operators', () => {
      expect(router.evaluate({ field: 'val', operator: 'is_empty', value: '' }, {})).toBe(true);
      expect(router.evaluate({ field: 'val', operator: 'is_empty', value: '' }, { val: '' })).toBe(
        true,
      );
      expect(
        router.evaluate({ field: 'val', operator: 'is_not_empty', value: '' }, { val: 'x' }),
      ).toBe(true);
      expect(router.evaluate({ field: 'val', operator: 'is_not_empty', value: '' }, {})).toBe(
        false,
      );
    });

    it('refuses to answer a pattern that does not compile, instead of answering false', () => {
      const condition: PipelineCondition = { field: 'val', operator: 'matches', value: '[invalid' };
      expect(() => router.evaluate(condition, { val: 'test' })).toThrow(
        'the condition matches "val" against "[invalid", which is not a valid pattern',
      );
    });

    it('finds a number equal to the text a run variable holds', () => {
      // A run's variables are all text, and strict `===` never found '5' equal to 5.
      const five: PipelineCondition = { field: 'count', operator: 'eq', value: 5 };
      expect(router.evaluate(five, { count: '5' })).toBe(true);
      expect(router.evaluate(five, { count: '5.0' })).toBe(true);
      expect(router.evaluate(five, { count: 'five' })).toBe(false);
      expect(router.evaluate(five, {})).toBe(false);
      expect(router.evaluate({ ...five, operator: 'neq' }, { count: '5' })).toBe(false);
      expect(router.evaluate({ ...five, operator: 'neq' }, { count: '6' })).toBe(true);
    });

    it('compares true and false as booleans, and text as text', () => {
      const enabled: PipelineCondition = { field: 'enabled', operator: 'eq', value: true };
      expect(router.evaluate(enabled, { enabled: 'true' })).toBe(true);
      expect(router.evaluate(enabled, { enabled: 'TRUE' })).toBe(true);
      expect(router.evaluate(enabled, { enabled: 'false' })).toBe(false);
      expect(router.evaluate({ ...enabled, value: false }, { enabled: 'false' })).toBe(true);

      const code: PipelineCondition = { field: 'code', operator: 'eq', value: '05' };
      expect(router.evaluate(code, { code: '05' })).toBe(true);
      expect(router.evaluate(code, { code: '5' })).toBe(false);
    });

    it('orders a number written as text', () => {
      const high: PipelineCondition = { field: 'usage', operator: 'gt', value: '80' };
      expect(router.evaluate(high, { usage: '95' })).toBe(true);
      expect(router.evaluate(high, { usage: '9' })).toBe(false);
    });

    it('does not answer an order for a value that is not a number', () => {
      // `Number('')` is 0: an unset variable was "less than 5", and a
      // threshold never reached read as a real answer.
      const small: PipelineCondition = { field: 'count', operator: 'lt', value: 5 };
      expect(() => router.evaluate(small, {})).toThrow('"count" has no value to compare with 5');
      expect(() => router.evaluate(small, { count: '' })).toThrow(
        '"count" has no value to compare with 5',
      );
      expect(() => router.evaluate(small, { count: 'many' })).toThrow(
        '"count" is "many", not a number to compare with 5',
      );
    });

    it('reads only the values the context holds, not what every object inherits', () => {
      expect(router.evaluate({ field: 'constructor', operator: 'is_empty', value: '' }, {})).toBe(
        true,
      );
    });
  });

  describe('check', () => {
    it('clears a condition every operator can answer', () => {
      expect(router.check({ field: 'env', operator: 'eq', value: 'prod' })).toBeUndefined();
      expect(router.check({ field: 'count', operator: 'gte', value: '3' })).toBeUndefined();
      expect(router.check({ field: 'id', operator: 'matches', value: '^a0' })).toBeUndefined();
      // Presence needs no value to compare with.
      expect(
        router.check({ field: 'env', operator: 'is_empty' } as unknown as PipelineCondition),
      ).toBeUndefined();
    });

    it('says why a condition cannot be evaluated, before any run asks it', () => {
      expect(router.check(undefined)).toBe('names no field to test');
      expect(router.check({ field: ' ', operator: 'eq', value: 'x' })).toBe(
        'names no field to test',
      );
      expect(router.check({ field: 'usage', operator: '>' as never, value: '80' })).toBe(
        'uses an unknown operator: >',
      );
      expect(router.check({ field: 'usage', operator: 'eq' } as unknown as PipelineCondition)).toBe(
        'compares "usage" with no value',
      );
      expect(router.check({ field: 'usage', operator: 'gt', value: 'high' })).toBe(
        'compares "usage" with "high", which is not a number',
      );
      expect(router.check({ field: 'usage', operator: 'lt', value: true })).toBe(
        'compares "usage" with true, which is not a number',
      );
      expect(router.check({ field: 'id', operator: 'matches', value: '(' })).toBe(
        'matches "id" against "(", which is not a valid pattern',
      );
    });
  });

  describe('evaluateGroup', () => {
    it('should return true for empty conditions array', () => {
      expect(router.evaluateGroup([], {})).toBe(true);
    });

    it('should evaluate AND group (all must match)', () => {
      const conditions: PipelineCondition[] = [
        { field: 'env', operator: 'eq', value: 'prod' },
        { field: 'region', operator: 'eq', value: 'us' },
      ];
      expect(router.evaluateGroup(conditions, { env: 'prod', region: 'us' })).toBe(true);
      expect(router.evaluateGroup(conditions, { env: 'prod', region: 'eu' })).toBe(false);
    });

    it('should evaluate OR group (any must match)', () => {
      const conditions: PipelineCondition[] = [
        { field: 'env', operator: 'eq', value: 'prod', logicalGroup: 'or' },
        { field: 'env', operator: 'eq', value: 'staging', logicalGroup: 'or' },
      ];
      expect(router.evaluateGroup(conditions, { env: 'prod' })).toBe(true);
      expect(router.evaluateGroup(conditions, { env: 'staging' })).toBe(true);
      expect(router.evaluateGroup(conditions, { env: 'dev' })).toBe(false);
    });
  });

  describe('getNextStep', () => {
    it('should return onSuccess for completed steps', () => {
      const step = createStep({ onSuccess: 'step-2', onFailure: 'step-3' });
      const result = createResult({ status: 'completed' });

      expect(router.getNextStep(step, result)).toBe('step-2');
    });

    it('should return onFailure for failed steps', () => {
      const step = createStep({ onSuccess: 'step-2', onFailure: 'step-3' });
      const result = createResult({ status: 'failed' });

      expect(router.getNextStep(step, result)).toBe('step-3');
    });

    it('should return undefined when no branching is configured', () => {
      const step = createStep();
      const result = createResult({ status: 'completed' });

      expect(router.getNextStep(step, result)).toBeUndefined();
    });

    it('should return undefined for pending/skipped/running statuses', () => {
      const step = createStep({ onSuccess: 'step-2', onFailure: 'step-3' });
      expect(router.getNextStep(step, createResult({ status: 'pending' }))).toBeUndefined();
      expect(router.getNextStep(step, createResult({ status: 'skipped' }))).toBeUndefined();
    });

    it('sends a Condition step whose condition does not hold to its onFailure step', () => {
      const step = createStep({ onSuccess: 'then', onFailure: 'else' });

      expect(router.getNextStep(step, createResult({ output: { conditionMet: false } }))).toBe(
        'else',
      );
      expect(router.getNextStep(step, createResult({ output: { conditionMet: true } }))).toBe(
        'then',
      );
    });
  });

  describe('endsRun', () => {
    const notMet = createResult({ output: { conditionMet: false } });

    it('ends the run after a Condition step whose condition does not hold', () => {
      expect(router.endsRun(createStep(), notMet)).toBe(true);
    });

    it('does not end it when the Condition names a step to go on from', () => {
      expect(router.endsRun(createStep({ onFailure: 'else' }), notMet)).toBe(false);
    });

    it('does not end it when the condition holds, or after any other step', () => {
      expect(router.endsRun(createStep(), createResult({ output: { conditionMet: true } }))).toBe(
        false,
      );
      expect(router.endsRun(createStep({ type: 'delay' }), notMet)).toBe(false);
      expect(router.endsRun(createStep(), createResult({ status: 'failed' }))).toBe(false);
    });
  });

  describe('findBranch', () => {
    it('should follow onSuccess chain', () => {
      const steps: PipelineStep[] = [
        createStep({ id: 's1', name: 'S1', onSuccess: 's2' }),
        createStep({ id: 's2', name: 'S2', onSuccess: 's3' }),
        createStep({ id: 's3', name: 'S3' }),
      ];

      const branch = router.findBranch(steps, 's1', true);
      expect(branch).toHaveLength(2);
      expect(branch[0].id).toBe('s2');
      expect(branch[1].id).toBe('s3');
    });

    it('should follow onFailure chain', () => {
      const steps: PipelineStep[] = [
        createStep({ id: 's1', name: 'S1', onFailure: 's3' }),
        createStep({ id: 's2', name: 'S2' }),
        createStep({ id: 's3', name: 'S3' }),
      ];

      const branch = router.findBranch(steps, 's1', false);
      expect(branch).toHaveLength(1);
      expect(branch[0].id).toBe('s3');
    });

    it('should return empty array when step ID is not found', () => {
      expect(router.findBranch([], 'non-existent', true)).toEqual([]);
    });

    it('should prevent infinite loops in circular references', () => {
      const steps: PipelineStep[] = [
        createStep({ id: 's1', name: 'S1', onSuccess: 's2' }),
        createStep({ id: 's2', name: 'S2', onSuccess: 's1' }),
      ];

      const branch = router.findBranch(steps, 's1', true);
      expect(branch).toHaveLength(2);
    });
  });
});
