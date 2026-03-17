import { describe, it, expect } from 'vitest';
import { enrichDiffs } from './enrichDiffs';
import type { CompareItem } from '@sandforge/shared';

function createItem(overrides: Partial<CompareItem> = {}): CompareItem {
  return {
    componentType: 'CustomField',
    fullName: 'Account.Field__c',
    status: 'modified',
    sourceValue: 'Text(50)',
    targetValue: 'Text(100)',
    severity: 'warning',
    deployable: true,
    ...overrides,
  };
}

describe('enrichDiffs', () => {
  it('should return empty report for empty items', () => {
    const report = enrichDiffs([]);
    expect(report.diffs).toHaveLength(0);
    expect(report.riskScore).toBe(0);
    expect(report.summary.total).toBe(0);
  });

  it('should exclude unchanged items', () => {
    const items = [
      createItem({ status: 'unchanged', severity: 'info' }),
      createItem({ status: 'modified' }),
    ];
    const report = enrichDiffs(items);
    expect(report.diffs).toHaveLength(1);
  });

  it('should group items correctly', () => {
    const items = [
      createItem({ componentType: 'ApexClass', status: 'modified' }),
      createItem({ componentType: 'CustomField', status: 'added', severity: 'info' }),
    ];
    const report = enrichDiffs(items);
    expect(report.diffs[0].group).toBe('Apex Code');
    expect(report.diffs[1].group).toBe('Data Model');
  });

  it('should compute summary counts', () => {
    const items = [
      createItem({ status: 'added', severity: 'info' }),
      createItem({ status: 'removed', severity: 'breaking' }),
      createItem({ status: 'modified' }),
    ];
    const report = enrichDiffs(items);
    expect(report.summary.total).toBe(3);
    expect(report.summary.added).toBe(1);
    expect(report.summary.removed).toBe(1);
    expect(report.summary.modified).toBe(1);
  });

  it('should assign risk levels', () => {
    const items = [
      createItem({
        componentType: 'CustomObject',
        status: 'removed',
        severity: 'breaking',
      }),
    ];
    const report = enrichDiffs(items);
    expect(report.diffs[0].riskLevel).toBe('critical');
  });

  it('should generate deployment advice', () => {
    const items = [
      createItem({
        componentType: 'ApexClass',
        status: 'modified',
        severity: 'warning',
      }),
    ];
    const report = enrichDiffs(items);
    expect(report.deploymentAdvice).toContain('Apex tests');
  });

  it('should count risks by level in summary', () => {
    const items = [
      createItem({ componentType: 'CustomObject', status: 'removed', severity: 'breaking' }),
      createItem({ componentType: 'CustomField', status: 'added', severity: 'info' }),
    ];
    const report = enrichDiffs(items);
    expect(report.summary.byRisk['critical']).toBe(1);
    expect(report.summary.byRisk['low']).toBe(1);
  });

  it('should cap risk score at 100', () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      createItem({
        componentType: 'CustomObject',
        fullName: `Obj${i}`,
        status: 'removed',
        severity: 'breaking',
      }),
    );
    const report = enrichDiffs(items);
    expect(report.riskScore).toBe(100);
  });
});
