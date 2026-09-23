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

describe('conditionDefect — every way a condition cannot be read', () => {
  it('refuses a blank field name and a condition that is not a condition at all', () => {
    expect(conditionDefect({ field: '  ', operator: 'eq', value: 'x' })).toBe(
      'names no field to test',
    );
    expect(
      conditionDefect({ field: 42, operator: 'eq', value: 'x' } as unknown as PipelineCondition),
    ).toBe('names no field to test');
  });

  it('asks nothing of the value when the operator only asks whether the field holds one', () => {
    expect(
      conditionDefect({
        field: 'owner',
        operator: 'is_empty',
        value: undefined as unknown as PipelineCondition['value'],
      }),
    ).toBe(undefined);
    expect(
      conditionDefect({
        field: 'owner',
        operator: 'is_not_empty',
        value: undefined as unknown as PipelineCondition['value'],
      }),
    ).toBe(undefined);
  });

  it('refuses a comparison with no value to compare with', () => {
    expect(
      conditionDefect({
        field: 'status',
        operator: 'eq',
        value: null as unknown as PipelineCondition['value'],
      }),
    ).toBe('compares "status" with no value');
  });

  it('takes a number written as text for an ordering, and never blank text', () => {
    expect(conditionDefect({ field: 'count', operator: 'gte', value: ' 12 ' })).toBe(undefined);
    expect(conditionDefect({ field: 'count', operator: 'lte', value: '   ' })).toBe(
      'compares "count" with "   ", which is not a number',
    );
    expect(conditionDefect({ field: 'count', operator: 'lt', value: Number.NaN })).toBe(
      'compares "count" with null, which is not a number',
    );
  });

  it('accepts a pattern that compiles', () => {
    expect(conditionDefect({ field: 'name', operator: 'matches', value: '^Acme' })).toBe(undefined);
  });
});

describe('evaluateCondition — each operator', () => {
  const at = (
    operator: PipelineCondition['operator'],
    value: PipelineCondition['value'],
    context: Record<string, unknown>,
  ): boolean => evaluateCondition({ field: 'f', operator, value }, context);

  it('compares equality the way the expected value is written', () => {
    // A number, as a number: text that spells it is equal, other text is not.
    expect(at('eq', 5, { f: '5' })).toBe(true);
    expect(at('eq', 5, { f: 5 })).toBe(true);
    expect(at('eq', 5, { f: 'five' })).toBe(false);
    expect(at('eq', 5, { f: Number.POSITIVE_INFINITY })).toBe(false);
    // A boolean, as a boolean: true/false in any case, and nothing else.
    expect(at('eq', true, { f: 'TRUE' })).toBe(true);
    expect(at('eq', false, { f: ' false ' })).toBe(true);
    expect(at('eq', true, { f: true })).toBe(true);
    expect(at('eq', true, { f: 'yes' })).toBe(false);
    expect(at('eq', true, { f: 1 })).toBe(false);
    // Anything else, as text; an unset value is empty text.
    expect(at('eq', 'Closed', { f: 'Closed' })).toBe(true);
    expect(at('eq', '', {})).toBe(true);
    expect(at('neq', 'Closed', { f: 'Open' })).toBe(true);
    expect(at('neq', 5, { f: '5' })).toBe(false);
  });

  it('orders numbers with each ordering operator', () => {
    expect(at('gt', 10, { f: '11' })).toBe(true);
    expect(at('gt', 10, { f: '10' })).toBe(false);
    expect(at('gte', 10, { f: 10 })).toBe(true);
    expect(at('lt', 10, { f: '9.5' })).toBe(true);
    expect(at('lt', 10, { f: 10 })).toBe(false);
    expect(at('lte', 10, { f: '10' })).toBe(true);
    expect(at('lte', '10', { f: 11 })).toBe(false);
  });

  it('gives no answer to an ordering when the field holds text that is no number', () => {
    expect(() => at('gt', 60, { f: 'high' })).toThrow(
      '"f" is "high", not a number to compare with 60',
    );
    expect(() => at('lt', 60, { f: null })).toThrow('"f" has no value to compare with 60');
  });

  it('looks for text inside the field, unset reading as empty', () => {
    expect(at('contains', 'cme', { f: 'Acme Corp' })).toBe(true);
    expect(at('contains', 'cme', {})).toBe(false);
    expect(at('not_contains', 'cme', { f: 'Globex' })).toBe(true);
    expect(at('not_contains', 'cme', { f: 'Acme' })).toBe(false);
  });

  it('matches the field against a pattern', () => {
    expect(at('matches', '^A.+p$', { f: 'Acme Corp' })).toBe(true);
    expect(at('matches', '^A', { f: 'Globex' })).toBe(false);
  });

  it('asks whether the field holds a value', () => {
    expect(at('is_empty', '', {})).toBe(true);
    expect(at('is_empty', '', { f: '' })).toBe(true);
    expect(at('is_empty', '', { f: null })).toBe(true);
    expect(at('is_empty', '', { f: 0 })).toBe(false);
    expect(at('is_not_empty', '', { f: 'x' })).toBe(true);
    expect(at('is_not_empty', '', { f: undefined })).toBe(false);
  });

  it('reads only the values the context holds itself, never one it inherits', () => {
    const context = Object.create({ f: 'inherited' }) as Record<string, unknown>;
    expect(at('is_empty', '', context)).toBe(true);
  });

  it('throws the reason a condition cannot be evaluated, for the step that asked', () => {
    expect(() => at('matches', '(', { f: 'x' })).toThrow(
      'the condition matches "f" against "(", which is not a valid pattern',
    );
  });
});
