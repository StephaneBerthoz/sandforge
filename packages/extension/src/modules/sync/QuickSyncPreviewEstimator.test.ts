import { describe, it, expect } from 'vitest';
import { QuickSyncPreviewEstimator } from './QuickSyncPreviewEstimator.js';

describe('QuickSyncPreviewEstimator', () => {
  const estimator = new QuickSyncPreviewEstimator();

  it('computes correct estimation for a single object with exact batch multiple', () => {
    const preview = estimator.estimate([
      { objectApiName: 'Account', count: 400 },
    ]);

    expect(preview.objects).toHaveLength(1);
    expect(preview.objects[0].estimatedApiCalls).toBe(2); // 400 / 200 = 2
    expect(preview.totalRecords).toBe(400);
    expect(preview.totalApiCalls).toBe(2);
    expect(preview.estimatedDurationSec).toBe(4); // 2 * 2
  });

  it('computes correct estimation for multiple objects with remainder', () => {
    const preview = estimator.estimate([
      { objectApiName: 'Account', count: 350 },
      { objectApiName: 'Contact', count: 150 },
    ]);

    expect(preview.objects).toHaveLength(2);
    expect(preview.objects[0].estimatedApiCalls).toBe(2); // ceil(350/200) = 2
    expect(preview.objects[1].estimatedApiCalls).toBe(1); // ceil(150/200) = 1
    expect(preview.totalRecords).toBe(500);
    expect(preview.totalApiCalls).toBe(3);
    expect(preview.estimatedDurationSec).toBe(6);
  });

  it('returns zero API calls for zero records', () => {
    const preview = estimator.estimate([
      { objectApiName: 'Account', count: 0 },
    ]);

    expect(preview.objects[0].estimatedApiCalls).toBe(0);
    expect(preview.totalRecords).toBe(0);
    expect(preview.totalApiCalls).toBe(0);
    expect(preview.estimatedDurationSec).toBe(0);
  });

  it('handles empty record counts array', () => {
    const preview = estimator.estimate([]);

    expect(preview.objects).toHaveLength(0);
    expect(preview.totalRecords).toBe(0);
    expect(preview.totalApiCalls).toBe(0);
  });

  it('marks parent dependencies correctly', () => {
    const preview = estimator.estimate(
      [
        { objectApiName: 'Account', count: 100 },
        { objectApiName: 'Opportunity', count: 50 },
      ],
      new Set(['Account']),
    );

    expect(preview.objects[0].isParentDependency).toBe(true);
    expect(preview.objects[1].isParentDependency).toBe(false);
  });

  it('uses custom batch size for estimation', () => {
    const preview = estimator.estimate(
      [{ objectApiName: 'Account', count: 500 }],
      new Set(),
      100,
    );

    expect(preview.objects[0].estimatedApiCalls).toBe(5); // 500 / 100
  });
});
