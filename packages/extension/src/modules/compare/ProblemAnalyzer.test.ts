import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProblemAnalyzer } from './ProblemAnalyzer';
import type { GenerateProblemIdFn } from './ProblemAnalyzer';
import type { CompareItem, MetadataComponentType } from '@sandforge/shared';

function createItem(
  componentType: MetadataComponentType,
  fullName: string,
  status: CompareItem['status'],
  severity: CompareItem['severity'] = 'info',
  fieldDiffs?: CompareItem['fieldDiffs']
): CompareItem {
  return {
    componentType,
    fullName,
    status,
    severity,
    deployable: status !== 'unchanged',
    fieldDiffs,
  };
}

describe('ProblemAnalyzer', () => {
  let analyzer: ProblemAnalyzer;
  let generateId: GenerateProblemIdFn;
  let idCounter: number;

  beforeEach(() => {
    idCounter = 0;
    generateId = vi.fn(() => {
      idCounter++;
      return `prob-${idCounter}`;
    });
    analyzer = new ProblemAnalyzer(generateId);
  });

  describe('analyze', () => {
    it('should return empty report for no diffs', () => {
      const report = analyzer.analyze([]);

      expect(report.problems).toHaveLength(0);
      expect(report.conflictCount).toBe(0);
      expect(report.breakingChangeCount).toBe(0);
    });

    it('should skip unchanged items', () => {
      const diffs = [createItem('ApexClass', 'MyClass', 'unchanged')];
      const report = analyzer.analyze(diffs);

      expect(report.problems).toHaveLength(0);
    });

    it('should count breaking changes', () => {
      const diffs = [
        createItem('ApexClass', 'ClassA', 'removed', 'breaking'),
        createItem('ApexTrigger', 'TriggerA', 'modified', 'breaking'),
      ];
      const report = analyzer.analyze(diffs);

      expect(report.breakingChangeCount).toBe(2);
    });

    it('should create problem entries for breaking changes', () => {
      const diffs = [createItem('ApexClass', 'MyClass', 'removed', 'breaking')];
      const report = analyzer.analyze(diffs);

      const breakingProblems = report.problems.filter((p) => p.severity === 'breaking');
      expect(breakingProblems).toHaveLength(1);
      expect(breakingProblems[0].fullName).toBe('MyClass');
      expect(breakingProblems[0].description).toContain('removed');
    });

    it('should create problem entries for warning changes', () => {
      const diffs = [createItem('Layout', 'AccountLayout', 'modified', 'warning')];
      const report = analyzer.analyze(diffs);

      const warnings = report.problems.filter((p) => p.severity === 'warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].description).toContain('modified');
    });

    it('should count conflicts for modified items with field diffs', () => {
      const diffs = [
        createItem('CustomObject', 'Account', 'modified', 'warning', [
          { fieldPath: 'Name', sourceValue: 'old', targetValue: 'new', status: 'modified' },
        ]),
      ];
      const report = analyzer.analyze(diffs);

      expect(report.conflictCount).toBe(1);
    });

    it('should not count conflicts for items without field diffs', () => {
      const diffs = [createItem('CustomObject', 'Account', 'modified', 'warning')];
      const report = analyzer.analyze(diffs);

      expect(report.conflictCount).toBe(0);
    });

    it('should detect data loss risk for removed custom fields', () => {
      const diffs = [createItem('CustomField', 'Account.Legacy__c', 'removed', 'breaking')];
      const report = analyzer.analyze(diffs);

      const dataLossProblem = report.problems.find((p) =>
        p.description.includes('data loss')
      );
      expect(dataLossProblem).toBeDefined();
      expect(dataLossProblem?.suggestion).toContain('Back up');
    });

    it('should detect flow version concern for modified flows', () => {
      const diffs = [createItem('Flow', 'MyFlow', 'modified', 'breaking')];
      const report = analyzer.analyze(diffs);

      const flowProblem = report.problems.find((p) =>
        p.description.includes('Active flow versions')
      );
      expect(flowProblem).toBeDefined();
      expect(flowProblem?.severity).toBe('info');
    });

    it('should detect automation risk for removed triggers', () => {
      const diffs = [createItem('ApexTrigger', 'AccountTrigger', 'removed', 'breaking')];
      const report = analyzer.analyze(diffs);

      const triggerProblem = report.problems.find((p) =>
        p.description.includes('critical automation')
      );
      expect(triggerProblem).toBeDefined();
    });

    it('should assign unique IDs to each problem', () => {
      const diffs = [
        createItem('ApexClass', 'A', 'removed', 'breaking'),
        createItem('ApexClass', 'B', 'removed', 'breaking'),
      ];
      const report = analyzer.analyze(diffs);

      const ids = report.problems.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should include suggestions in every problem', () => {
      const diffs = [
        createItem('ApexClass', 'A', 'removed', 'breaking'),
        createItem('Layout', 'L', 'modified', 'warning'),
      ];
      const report = analyzer.analyze(diffs);

      for (const problem of report.problems) {
        expect(problem.suggestion.length).toBeGreaterThan(0);
      }
    });

    it('should include component type in every problem', () => {
      const diffs = [createItem('Flow', 'MyFlow', 'removed', 'breaking')];
      const report = analyzer.analyze(diffs);

      for (const problem of report.problems) {
        expect(problem.componentType).toBeDefined();
      }
    });

    it('should not flag info-severity items as problems', () => {
      const diffs = [createItem('CustomLabel', 'Label1', 'added', 'info')];
      const report = analyzer.analyze(diffs);

      const nonContextual = report.problems.filter(
        (p) => p.severity === 'breaking' || p.severity === 'warning'
      );
      expect(nonContextual).toHaveLength(0);
    });

    it('should handle large numbers of diffs', () => {
      const diffs: CompareItem[] = [];
      for (let i = 0; i < 100; i++) {
        diffs.push(createItem('ApexClass', `Class${i}`, 'modified', 'warning'));
      }

      const report = analyzer.analyze(diffs);

      expect(report.problems.length).toBeGreaterThanOrEqual(100);
      expect(report.breakingChangeCount).toBe(0);
    });

    it('should provide description with correct status for modified breaking items', () => {
      const diffs = [createItem('ApexClass', 'MyClass', 'modified', 'breaking')];
      const report = analyzer.analyze(diffs);

      const breaking = report.problems.find((p) => p.severity === 'breaking');
      expect(breaking?.description).toContain('modified');
    });
  });
});
