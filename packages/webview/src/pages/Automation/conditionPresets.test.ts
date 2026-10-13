import { describe, expect, it } from 'vitest';
import { conditionDefect } from '@sandforge/shared';
import {
  CONDITION_KINDS,
  conditionFor,
  kindOf,
  takesThreshold,
  thresholdMax,
} from './conditionPresets';

describe('conditionFor', () => {
  it('writes "the previous step failed" as the value the run hands on after each step', () => {
    expect(conditionFor('previousFailed')).toEqual({
      field: 'previousStepStatus',
      operator: 'eq',
      value: 'failed',
    });
    expect(conditionFor('previousSucceeded').value).toBe('succeeded');
  });

  it('writes "Compare found more than N differences" on the count a Compare step hands on', () => {
    expect(conditionFor('compareDifferences', 25)).toEqual({
      field: 'compareDifferenceCount',
      operator: 'gt',
      value: 25,
    });
  });

  it('writes only conditions the extension can evaluate', () => {
    for (const kind of CONDITION_KINDS) {
      expect(conditionDefect(conditionFor(kind, 5))).toBeUndefined();
    }
  });
});

describe('kindOf', () => {
  it('reads back every condition the panel writes, with its threshold', () => {
    for (const kind of CONDITION_KINDS) {
      expect(kindOf(conditionFor(kind, 7))).toEqual(
        takesThreshold(kind) ? { kind, threshold: 7 } : { kind },
      );
    }
  });

  it("reads the Marketplace template's API usage condition as the kind it is", () => {
    expect(kindOf({ field: 'apiUsagePercent', operator: 'gt', value: 60 })).toEqual({
      kind: 'apiUsage',
      threshold: 60,
    });
  });

  it('calls a condition none of the kinds writes no kind', () => {
    expect(kindOf({ field: 'env', operator: 'eq', value: 'prod' })).toBeUndefined();
    expect(kindOf({ field: 'apiUsagePercent', operator: 'lt', value: 60 })).toBeUndefined();
    expect(kindOf(undefined)).toBeUndefined();
  });
});

describe('thresholdMax', () => {
  it('stops a percentage at 100 and leaves a count unbounded', () => {
    expect(thresholdMax('apiUsage')).toBe(100);
    expect(thresholdMax('compareDifferences')).toBeUndefined();
  });
});
