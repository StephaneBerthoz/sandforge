import { describe, it, expect, beforeEach } from 'vitest';
import { ConditionalRouter } from './ConditionalRouter';
import type {
  PipelineCondition,
  PipelineStep,
  PipelineStepResult,
} from '@sandforge/shared';

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
      expect(router.evaluate({ field: 'count', operator: 'gt', value: 5 }, { count: 10 })).toBe(true);
      expect(router.evaluate({ field: 'count', operator: 'gt', value: 5 }, { count: 3 })).toBe(false);
      expect(router.evaluate({ field: 'count', operator: 'gte', value: 5 }, { count: 5 })).toBe(true);
      expect(router.evaluate({ field: 'count', operator: 'lt', value: 5 }, { count: 3 })).toBe(true);
      expect(router.evaluate({ field: 'count', operator: 'lte', value: 5 }, { count: 5 })).toBe(true);
    });

    it('should evaluate contains and not_contains operators', () => {
      const context = { name: 'hello world' };
      expect(router.evaluate({ field: 'name', operator: 'contains', value: 'world' }, context)).toBe(true);
      expect(router.evaluate({ field: 'name', operator: 'not_contains', value: 'foo' }, context)).toBe(true);
      expect(router.evaluate({ field: 'name', operator: 'contains', value: 'foo' }, context)).toBe(false);
    });

    it('should evaluate matches operator with regex', () => {
      const condition: PipelineCondition = { field: 'email', operator: 'matches', value: '^test@' };
      expect(router.evaluate(condition, { email: 'test@example.com' })).toBe(true);
      expect(router.evaluate(condition, { email: 'user@example.com' })).toBe(false);
    });

    it('should evaluate is_empty and is_not_empty operators', () => {
      expect(router.evaluate({ field: 'val', operator: 'is_empty', value: '' }, {})).toBe(true);
      expect(router.evaluate({ field: 'val', operator: 'is_empty', value: '' }, { val: '' })).toBe(true);
      expect(router.evaluate({ field: 'val', operator: 'is_not_empty', value: '' }, { val: 'x' })).toBe(true);
      expect(router.evaluate({ field: 'val', operator: 'is_not_empty', value: '' }, {})).toBe(false);
    });

    it('should handle matches operator with invalid regex', () => {
      const condition: PipelineCondition = { field: 'val', operator: 'matches', value: '[invalid' };
      expect(router.evaluate(condition, { val: 'test' })).toBe(false);
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
