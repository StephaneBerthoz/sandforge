import { describe, it, expect, beforeEach } from 'vitest';
import { DiffAnalyzer } from './DiffAnalyzer';
import type { CompareItem } from '@sandforge/shared';

function createItem(overrides: Partial<CompareItem> = {}): CompareItem {
  return {
    componentType: 'CustomField',
    fullName: 'Account.CustomField__c',
    status: 'modified',
    sourceValue: 'Text(50)',
    targetValue: 'Text(100)',
    severity: 'warning',
    deployable: true,
    ...overrides,
  };
}

describe('DiffAnalyzer', () => {
  let analyzer: DiffAnalyzer;

  beforeEach(() => {
    analyzer = new DiffAnalyzer();
  });

  it('should return empty report for empty items', () => {
    const report = analyzer.analyze([]);
    expect(report.diffs).toHaveLength(0);
    expect(report.riskScore).toBe(0);
    expect(report.summary.total).toBe(0);
    expect(report.deploymentAdvice).toBe('No changes to deploy.');
  });

  it('should exclude unchanged items', () => {
    const items: CompareItem[] = [
      createItem({ status: 'unchanged', severity: 'info' }),
      createItem({ status: 'modified' }),
    ];
    const report = analyzer.analyze(items);
    expect(report.diffs).toHaveLength(1);
    expect(report.summary.total).toBe(1);
  });

  it('should enrich items with correct groups', () => {
    const items: CompareItem[] = [
      createItem({ componentType: 'ApexClass', status: 'modified' }),
      createItem({ componentType: 'Profile', status: 'modified' }),
      createItem({ componentType: 'Layout', status: 'added', severity: 'info' }),
    ];
    const report = analyzer.analyze(items);
    const groups = report.diffs.map((d) => d.group);
    expect(groups).toContain('Apex Code');
    expect(groups).toContain('Security');
    expect(groups).toContain('Configuration');
  });

  it('should count changes by type in summary', () => {
    const items: CompareItem[] = [
      createItem({ status: 'added', severity: 'info' }),
      createItem({ status: 'added', severity: 'info' }),
      createItem({ status: 'removed', severity: 'breaking' }),
      createItem({ status: 'modified' }),
    ];
    const report = analyzer.analyze(items);
    expect(report.summary.added).toBe(2);
    expect(report.summary.removed).toBe(1);
    expect(report.summary.modified).toBe(1);
    expect(report.summary.total).toBe(4);
  });

  describe('risk levels', () => {
    it('should assign critical risk for breaking removed CustomObject', () => {
      const items = [
        createItem({
          componentType: 'CustomObject',
          status: 'removed',
          severity: 'breaking',
        }),
      ];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].riskLevel).toBe('critical');
    });

    it('should assign high risk for breaking modified items', () => {
      const items = [
        createItem({
          componentType: 'ApexClass',
          status: 'modified',
          severity: 'breaking',
        }),
      ];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].riskLevel).toBe('high');
    });

    it('should assign none risk for low-weight added items', () => {
      const items = [
        createItem({
          componentType: 'CustomLabel',
          status: 'added',
          severity: 'info',
        }),
      ];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].riskLevel).toBe('none');
    });

    it('should assign low risk for higher-weight added items', () => {
      const items = [
        createItem({
          componentType: 'CustomField',
          status: 'added',
          severity: 'info',
        }),
      ];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].riskLevel).toBe('low');
    });

    it('should count risks by level in summary', () => {
      const items: CompareItem[] = [
        createItem({ componentType: 'CustomObject', status: 'removed', severity: 'breaking' }),
        createItem({ componentType: 'CustomField', status: 'added', severity: 'info' }),
      ];
      const report = analyzer.analyze(items);
      expect(report.summary.byRisk['critical']).toBe(1);
      expect(report.summary.byRisk['low']).toBe(1);
    });
  });

  describe('risk reasons', () => {
    it('should note data loss risk for removed CustomField', () => {
      const items = [
        createItem({
          componentType: 'CustomField',
          status: 'removed',
          severity: 'breaking',
        }),
      ];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].riskReasons).toContain(
        'Removing data model components may cause data loss.',
      );
    });

    it('should note breaking change risk', () => {
      const items = [createItem({ severity: 'breaking', status: 'modified' })];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].riskReasons).toContain(
        'This is a breaking change that requires careful review.',
      );
    });

    it('should note low risk for added items', () => {
      const items = [createItem({ status: 'added', severity: 'info' })];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].riskReasons).toContain('New component — low risk.');
    });

    it('should note automation risk for modified Flow', () => {
      const items = [
        createItem({ componentType: 'Flow', status: 'modified', severity: 'breaking' }),
      ];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].riskReasons).toContain(
        'Flow changes may affect active process automations.',
      );
    });
  });

  describe('dependencies', () => {
    it('should resolve dependencies for CustomObject', () => {
      const items = [createItem({ componentType: 'CustomObject', status: 'modified' })];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].dependencies).toContain('CustomField');
      expect(report.diffs[0].dependencies).toContain('ValidationRule');
      expect(report.diffs[0].dependencies).toContain('ApexTrigger');
    });

    it('should return empty dependencies for types without deps', () => {
      const items = [
        createItem({ componentType: 'StaticResource', status: 'added', severity: 'info' }),
      ];
      const report = analyzer.analyze(items);
      expect(report.diffs[0].dependencies).toHaveLength(0);
    });
  });

  describe('risk score', () => {
    it('should compute low risk score for minor changes', () => {
      const items = [
        createItem({ componentType: 'CustomLabel', status: 'added', severity: 'info' }),
      ];
      const report = analyzer.analyze(items);
      expect(report.riskScore).toBeLessThan(25);
    });

    it('should compute high risk score for many breaking changes', () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        createItem({
          componentType: 'ApexClass',
          fullName: `Class${i}`,
          status: 'removed',
          severity: 'breaking',
        }),
      );
      const report = analyzer.analyze(items);
      expect(report.riskScore).toBeGreaterThanOrEqual(50);
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
      const report = analyzer.analyze(items);
      expect(report.riskScore).toBe(100);
    });
  });

  describe('deployment advice', () => {
    it('should mention critical changes in advice', () => {
      const items = [
        createItem({
          componentType: 'CustomObject',
          status: 'removed',
          severity: 'breaking',
        }),
      ];
      const report = analyzer.analyze(items);
      expect(report.deploymentAdvice).toContain('critical-risk');
      expect(report.deploymentAdvice).toContain('Manual review');
    });

    it('should mention Apex tests when Apex is changed', () => {
      const items = [
        createItem({ componentType: 'ApexClass', status: 'modified', severity: 'warning' }),
      ];
      const report = analyzer.analyze(items);
      expect(report.deploymentAdvice).toContain('Apex tests');
    });

    it('should mention removed components verification', () => {
      const items = [createItem({ status: 'removed', severity: 'breaking' })];
      const report = analyzer.analyze(items);
      expect(report.deploymentAdvice).toContain('Verify removed components');
    });

    it('should say safe to deploy for low risk', () => {
      const items = [
        createItem({ componentType: 'CustomLabel', status: 'added', severity: 'info' }),
      ];
      const report = analyzer.analyze(items);
      expect(report.deploymentAdvice).toContain('Safe to deploy');
    });
  });

  describe('combined analysis', () => {
    it('should handle a realistic mixed changeset', () => {
      const items: CompareItem[] = [
        createItem({
          componentType: 'ApexClass',
          fullName: 'AccountController',
          status: 'modified',
          severity: 'breaking',
        }),
        createItem({
          componentType: 'ApexTrigger',
          fullName: 'AccountTrigger',
          status: 'removed',
          severity: 'breaking',
        }),
        createItem({
          componentType: 'CustomField',
          fullName: 'Account.NewField__c',
          status: 'added',
          severity: 'info',
        }),
        createItem({
          componentType: 'Flow',
          fullName: 'Account_Automation',
          status: 'modified',
          severity: 'breaking',
        }),
        createItem({
          componentType: 'Profile',
          fullName: 'System Administrator',
          status: 'modified',
          severity: 'warning',
        }),
      ];
      const report = analyzer.analyze(items);

      expect(report.diffs).toHaveLength(5);
      expect(report.summary.total).toBe(5);
      expect(report.summary.added).toBe(1);
      expect(report.summary.removed).toBe(1);
      expect(report.summary.modified).toBe(3);
      expect(report.riskScore).toBeGreaterThan(0);
      expect(report.deploymentAdvice.length).toBeGreaterThan(0);

      // Check grouping
      const groups = new Set(report.diffs.map((d) => d.group));
      expect(groups.has('Apex Code')).toBe(true);
      expect(groups.has('Data Model')).toBe(true);
      expect(groups.has('Automation')).toBe(true);
      expect(groups.has('Security')).toBe(true);
    });
  });
});
