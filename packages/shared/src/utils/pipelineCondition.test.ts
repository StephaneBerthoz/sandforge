import { describe, it, expect } from 'vitest';
import { conditionDefect, evaluateCondition } from './pipelineCondition';
import type { PipelineCondition } from '../types/automation.types';

describe('conditionDefect', () => {
  it('finds nothing wrong with a condition that orders a field against a number', () => {
    expect(conditionDefect({ field: 'apiUsagePercent', operator: 'gt', value: 60 })).toBe(
      undefined,
    );
  });

  it('says why a condition cannot be evaluated: no field, an unknown operator, a value that is no number', () => {
    expect(conditionDefect(undefined)).toBe('names no field to test');
    expect(
      conditionDefect({
        field: 'apiUsagePercent',
        operator: '>' as PipelineCondition['operator'],
        value: 80,
      }),
    ).toBe('uses an unknown operator: >');
    expect(conditionDefect({ field: 'count', operator: 'lt', value: 'many' })).toBe(
      'compares "count" with "many", which is not a number',
    );
    expect(conditionDefect({ field: 'name', operator: 'matches', value: '(' })).toBe(
      'matches "name" against "(", which is not a valid pattern',
    );
  });
});

describe('evaluateCondition', () => {
  it('reads a number a run holds as text', () => {
    const condition: PipelineCondition = { field: 'apiUsagePercent', operator: 'gt', value: 60 };
    expect(evaluateCondition(condition, { apiUsagePercent: '72' })).toBe(true);
    expect(evaluateCondition(condition, { apiUsagePercent: '41' })).toBe(false);
  });

  it('gives no answer when the field it orders holds no number', () => {
    expect(() =>
      evaluateCondition({ field: 'apiUsagePercent', operator: 'gt', value: 60 }, {}),
    ).toThrow('"apiUsagePercent" has no value to compare with 60');
  });
});
