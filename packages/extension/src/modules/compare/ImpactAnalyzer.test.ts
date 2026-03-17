import { describe, it, expect, beforeEach } from 'vitest';
import { ImpactAnalyzer } from './ImpactAnalyzer';
import type { CompareItem, MetadataComponentType } from '@sandforge/shared';

function createItem(
  componentType: MetadataComponentType,
  fullName: string,
  status: CompareItem['status'],
  severity: CompareItem['severity'] = 'info'
): CompareItem {
  return {
    componentType,
    fullName,
    status,
    severity,
    deployable: status !== 'unchanged',
  };
}

describe('ImpactAnalyzer', () => {
  let analyzer: ImpactAnalyzer;

  beforeEach(() => {
    analyzer = new ImpactAnalyzer();
  });

  describe('analyze', () => {
    it('should return zero impact score for no changes', () => {
      const result = analyzer.analyze([]);

      expect(result.impactScore).toBe(0);
      expect(result.riskLevel).toBe('low');
    });

    it('should ignore unchanged items', () => {
      const items = [createItem('ApexClass', 'MyClass', 'unchanged')];
      const result = analyzer.analyze(items);

      expect(result.impactScore).toBe(0);
      expect(result.affectedComponents).toHaveLength(0);
    });

    it('should identify direct affected components', () => {
      const items = [createItem('ApexClass', 'MyClass', 'modified')];
      const result = analyzer.analyze(items);

      const direct = result.affectedComponents.filter((c) => c.impactType === 'direct');
      expect(direct).toHaveLength(1);
      expect(direct[0].fullName).toBe('MyClass');
    });

    it('should identify indirect affected components for CustomObject', () => {
      const items = [createItem('CustomObject', 'Account', 'modified')];
      const result = analyzer.analyze(items);

      const indirect = result.affectedComponents.filter((c) => c.impactType === 'indirect');
      expect(indirect.length).toBeGreaterThan(0);
    });

    it('should build dependency links for components with dependencies', () => {
      const items = [createItem('CustomObject', 'Account', 'modified')];
      const result = analyzer.analyze(items);

      expect(result.dependencies.length).toBeGreaterThan(0);
      expect(result.dependencies[0].source).toBe('Account');
    });

    it('should produce no dependency links for components without dependencies', () => {
      const items = [createItem('Report', 'MyReport', 'added')];
      const result = analyzer.analyze(items);

      expect(result.dependencies).toHaveLength(0);
    });

    it('should assign higher impact score to removed items', () => {
      const modifiedItems = [createItem('ApexClass', 'A', 'modified')];
      const removedItems = [createItem('ApexClass', 'A', 'removed')];

      const modifiedResult = analyzer.analyze(modifiedItems);
      const removedResult = analyzer.analyze(removedItems);

      expect(removedResult.impactScore).toBeGreaterThan(modifiedResult.impactScore);
    });

    it('should assign higher weight to critical component types', () => {
      const objectItems = [createItem('CustomObject', 'X', 'modified')];
      const labelItems = [createItem('CustomLabel', 'X', 'modified')];

      const objectResult = analyzer.analyze(objectItems);
      const labelResult = analyzer.analyze(labelItems);

      expect(objectResult.impactScore).toBeGreaterThan(labelResult.impactScore);
    });

    it('should cap impact score at 100', () => {
      const items: CompareItem[] = [];
      for (let i = 0; i < 100; i++) {
        items.push(createItem('CustomObject', `Obj${i}`, 'removed', 'breaking'));
      }

      const result = analyzer.analyze(items);

      expect(result.impactScore).toBeLessThanOrEqual(100);
    });

    it('should return low risk for small changes', () => {
      const items = [createItem('CustomLabel', 'Label1', 'added')];
      const result = analyzer.analyze(items);

      expect(result.riskLevel).toBe('low');
    });

    it('should return critical risk for very large changes', () => {
      const items: CompareItem[] = [];
      for (let i = 0; i < 50; i++) {
        items.push(createItem('ApexTrigger', `Trigger${i}`, 'removed', 'breaking'));
      }

      const result = analyzer.analyze(items);

      expect(result.riskLevel).toBe('critical');
    });

    it('should recommend running Apex tests when Apex changes exist', () => {
      const items = [createItem('ApexClass', 'MyClass', 'modified')];
      const result = analyzer.analyze(items);

      expect(result.recommendations).toContain(
        'Run all Apex tests in the target org before deploying.'
      );
    });

    it('should recommend reviewing breaking changes', () => {
      const items = [createItem('ApexClass', 'MyClass', 'removed', 'breaking')];
      const result = analyzer.analyze(items);

      expect(result.recommendations).toContain(
        'Review breaking changes carefully before deployment.'
      );
    });

    it('should recommend verifying removed components', () => {
      const items = [createItem('CustomLabel', 'Label1', 'removed')];
      const result = analyzer.analyze(items);

      expect(result.recommendations).toContain(
        'Verify that removed components are not referenced elsewhere.'
      );
    });

    it('should recommend security review for permission changes', () => {
      const items = [createItem('Profile', 'Admin', 'modified', 'warning')];
      const result = analyzer.analyze(items);

      expect(result.recommendations).toContain(
        'Validate permission changes with the security team.'
      );
    });

    it('should recommend splitting large deployments', () => {
      const items: CompareItem[] = [];
      for (let i = 0; i < 60; i++) {
        items.push(createItem('CustomLabel', `Label${i}`, 'added'));
      }

      const result = analyzer.analyze(items);

      expect(result.recommendations).toContain(
        'Consider splitting into smaller deployments.'
      );
    });

    it('should recommend staging for high risk deployments', () => {
      const items: CompareItem[] = [];
      for (let i = 0; i < 30; i++) {
        items.push(createItem('ApexTrigger', `Trigger${i}`, 'removed', 'breaking'));
      }

      const result = analyzer.analyze(items);

      expect(result.recommendations).toContain(
        'Consider deploying to a staging sandbox first.'
      );
    });

    it('should return empty recommendations for safe changes', () => {
      const items = [createItem('CustomLabel', 'Label1', 'added')];
      const result = analyzer.analyze(items);

      expect(result.recommendations.length).toBeLessThanOrEqual(1);
    });
  });
});
