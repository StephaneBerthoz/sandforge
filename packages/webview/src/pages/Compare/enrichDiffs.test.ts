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
      createItem({ status: 'added', severity: 'breaking' }),
      createItem({ status: 'removed', severity: 'info' }),
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
        status: 'added',
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
    expect(report.deploymentAdvice).toContainEqual({ kind: 'apexTests' });
  });

  it('should count risks by level in summary', () => {
    const items = [
      createItem({ componentType: 'CustomObject', status: 'added', severity: 'breaking' }),
      createItem({ componentType: 'CustomField', status: 'removed', severity: 'info' }),
    ];
    const report = enrichDiffs(items);
    expect(report.summary.byRisk['critical']).toBe(1);
    expect(report.summary.byRisk['low']).toBe(1);
  });

  it('scores no component whose content was not compared, which is not known to differ', () => {
    const items = [
      createItem({
        componentType: 'ApexTrigger',
        fullName: 'OnAccount',
        status: 'not_compared',
        severity: 'info',
        deployable: false,
        notComparedReason: 'over_budget',
      }),
      createItem({
        componentType: 'CustomObject',
        fullName: 'Invoice__c',
        status: 'not_compared',
        severity: 'info',
        deployable: false,
        notComparedReason: 'read_failed',
      }),
    ];

    const report = enrichDiffs(items);

    expect(report.diffs).toHaveLength(0);
    expect(report.summary).toMatchObject({ total: 0, added: 0, removed: 0, modified: 0 });
    expect(report.riskScore).toBe(0);
  });

  it('does not call a comparison safe to deploy while part of it was not compared', () => {
    const added = createItem({ componentType: 'CustomLabel', status: 'removed', severity: 'info' });
    const unread = createItem({
      status: 'not_compared',
      severity: 'info',
      deployable: false,
      notComparedReason: 'over_budget',
    });

    expect(enrichDiffs([added]).deploymentAdvice).toEqual([{ kind: 'lowRisk' }]);
    expect(enrichDiffs([added, unread]).deploymentAdvice).not.toContainEqual({ kind: 'lowRisk' });
  });

  describe('added and removed, as the comparison defines them', () => {
    // `removed` is only in the source, `added` only in the target. The card
    // read them the other way round: it warned that a data model component
    // only the source held was being removed and "may cause data loss", and
    // rated the one only the target held a new component, low risk.

    it('rates a component only the source holds as one a deployment creates', () => {
      const report = enrichDiffs([
        createItem({ componentType: 'CustomObject', status: 'removed', severity: 'info' }),
        createItem({ componentType: 'ApexTrigger', status: 'removed', severity: 'info' }),
      ]);

      expect(report.diffs.map((d) => [d.riskLevel, d.riskReasons])).toEqual([
        ['low', ['sourceOnly']],
        ['low', ['sourceOnly']],
      ]);
      expect(report.deploymentAdvice).not.toContainEqual(
        expect.objectContaining({ kind: 'critical' }),
      );
    });

    it('warns about taking out what only the target holds', () => {
      const report = enrichDiffs([
        createItem({ componentType: 'CustomField', status: 'added', severity: 'breaking' }),
        createItem({ componentType: 'ApexClass', status: 'added', severity: 'breaking' }),
      ]);

      expect(report.diffs.map((d) => [d.riskLevel, d.riskReasons])).toEqual([
        ['critical', ['targetOnlyDataModel', 'breaking']],
        ['critical', ['targetOnlyApex', 'breaking']],
      ]);
    });

    it('scores a component only the target holds above one only the source holds', () => {
      const sourceOnly = enrichDiffs([
        createItem({ componentType: 'CustomObject', status: 'removed', severity: 'info' }),
      ]);
      const targetOnly = enrichDiffs([
        createItem({ componentType: 'CustomObject', status: 'added', severity: 'breaking' }),
      ]);
      expect(targetOnly.riskScore).toBeGreaterThan(sourceOnly.riskScore);
    });
  });

  it('should cap risk score at 100', () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      createItem({
        componentType: 'CustomObject',
        fullName: `Obj${i}`,
        status: 'added',
        severity: 'breaking',
      }),
    );
    const report = enrichDiffs(items);
    expect(report.riskScore).toBe(100);
  });
});
