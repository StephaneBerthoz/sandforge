import { describe, it, expect } from 'vitest';

import { determineExecutionStatus, aggregateResults } from './execution-result.js';

describe('determineExecutionStatus', () => {
  it('returns "success" when all items succeed', () => {
    const results = [{ success: true }, { success: true }, { success: true }];
    expect(determineExecutionStatus(results)).toBe('success');
  });

  it('returns "failed" when all items fail', () => {
    const results = [{ success: false }, { success: false }];
    expect(determineExecutionStatus(results)).toBe('failed');
  });

  it('returns "partial" when some succeed and some fail', () => {
    const results = [{ success: true }, { success: false }, { success: true }];
    expect(determineExecutionStatus(results)).toBe('partial');
  });

  it('returns "success" for an empty array', () => {
    expect(determineExecutionStatus([])).toBe('success');
  });

  it('returns "success" for a single success item', () => {
    expect(determineExecutionStatus([{ success: true }])).toBe('success');
  });

  it('returns "failed" for a single failed item', () => {
    expect(determineExecutionStatus([{ success: false }])).toBe('failed');
  });
});

describe('aggregateResults', () => {
  it('sums record and error counts', () => {
    const results = [
      { recordCount: 100, errorCount: 5 },
      { recordCount: 200, errorCount: 10 },
    ];
    const agg = aggregateResults(results);
    expect(agg.totalRecords).toBe(300);
    expect(agg.totalErrors).toBe(15);
  });

  it('computes success rate correctly', () => {
    const results = [
      { recordCount: 100, errorCount: 10 },
      { recordCount: 100, errorCount: 10 },
    ];
    const agg = aggregateResults(results);
    // (200 - 20) / 200 = 0.9 = 90%
    expect(agg.successRate).toBe(90);
  });

  it('returns 100% success rate for empty results', () => {
    const agg = aggregateResults([]);
    expect(agg.totalRecords).toBe(0);
    expect(agg.totalErrors).toBe(0);
    expect(agg.successRate).toBe(100);
  });

  it('returns 100% when there are zero errors', () => {
    const results = [
      { recordCount: 50, errorCount: 0 },
      { recordCount: 150, errorCount: 0 },
    ];
    const agg = aggregateResults(results);
    expect(agg.successRate).toBe(100);
  });

  it('returns 0% when all records are errors', () => {
    const results = [{ recordCount: 100, errorCount: 100 }];
    const agg = aggregateResults(results);
    expect(agg.successRate).toBe(0);
  });

  it('handles fractional success rates with two decimal places', () => {
    // (3 - 1) / 3 = 0.666... => 66.67%
    const results = [{ recordCount: 3, errorCount: 1 }];
    const agg = aggregateResults(results);
    expect(agg.successRate).toBe(66.67);
  });

  it('preserves extra properties on input items', () => {
    const results = [{ recordCount: 10, errorCount: 1, objectName: 'Account' }];
    const agg = aggregateResults(results);
    expect(agg.totalRecords).toBe(10);
    expect(agg.totalErrors).toBe(1);
  });
});
