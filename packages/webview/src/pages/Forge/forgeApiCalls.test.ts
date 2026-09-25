import { describe, it, expect } from 'vitest';
import type { ForgeGraphNode } from '@sandforge/shared';
import { buildSyntheticForgeGraph } from '@sandforge/shared';
import { estimatedApiCallsOf } from './forgeApiCalls';

/** A node discovery counted, with the calls it put on it. */
function counted(
  objectApiName: string,
  estimatedApiCalls: number,
  included = true,
): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: estimatedApiCalls * 200,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls,
    batchStrategy: 'auto',
  };
}

describe('estimatedApiCallsOf', () => {
  it('adds up the calls discovery put on the objects the run takes', () => {
    expect(estimatedApiCallsOf([counted('Account', 2), counted('Contact', 3)])).toBe(5);
  });

  it('leaves out an object the run does not take', () => {
    expect(estimatedApiCallsOf([counted('Account', 2), counted('CaseHistory', 240, false)])).toBe(
      2,
    );
  });

  it('has no estimate when an object the run takes was never counted', () => {
    // A starter template's graph skips discovery: each estimate is a
    // placeholder zero, and the run makes calls all the same.
    const template = buildSyntheticForgeGraph(['Account', 'Contact']).nodes;
    expect(estimatedApiCallsOf([counted('Case', 1), ...template])).toBeNull();
  });

  it('keeps an estimate when the object never counted is one the run does not take', () => {
    const [notTaken] = buildSyntheticForgeGraph(['Contact']).nodes;
    expect(estimatedApiCallsOf([counted('Account', 4), { ...notTaken, included: false }])).toBe(4);
  });
});
