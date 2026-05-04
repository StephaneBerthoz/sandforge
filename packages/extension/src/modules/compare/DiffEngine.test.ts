import { describe, it, expect, beforeEach } from 'vitest';
import { DiffEngine } from './DiffEngine';
import type { CompareItem, MetadataComponentType } from '@sandforge/shared';

describe('DiffEngine', () => {
  let engine: DiffEngine;

  beforeEach(() => {
    engine = new DiffEngine();
  });

  describe('diff', () => {
    it('should detect added components in target', () => {
      const source = new Map<string, string>();
      const target = new Map([['Account.Name', '<field>Name</field>']]);

      const items = engine.diff(source, target, 'CustomField');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('added');
      expect(items[0].fullName).toBe('Account.Name');
      expect(items[0].targetValue).toBe('<field>Name</field>');
      expect(items[0].sourceValue).toBeUndefined();
    });

    it('should detect removed components missing from target', () => {
      const source = new Map([['MyClass', 'public class MyClass {}']]);
      const target = new Map<string, string>();

      const items = engine.diff(source, target, 'ApexClass');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('removed');
      expect(items[0].fullName).toBe('MyClass');
      expect(items[0].sourceValue).toBe('public class MyClass {}');
      expect(items[0].targetValue).toBeUndefined();
    });

    it('should detect modified components with different content', () => {
      const source = new Map([['MyClass', 'v1']]);
      const target = new Map([['MyClass', 'v2']]);

      const items = engine.diff(source, target, 'ApexClass');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('modified');
      expect(items[0].sourceValue).toBe('v1');
      expect(items[0].targetValue).toBe('v2');
    });

    it('should detect unchanged components with identical content', () => {
      const source = new Map([['MyClass', 'same']]);
      const target = new Map([['MyClass', 'same']]);

      const items = engine.diff(source, target, 'ApexClass');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('unchanged');
    });

    it('should handle mixed statuses across multiple components', () => {
      const source = new Map([
        ['ClassA', 'a1'],
        ['ClassB', 'b1'],
        ['ClassC', 'c1'],
      ]);
      const target = new Map([
        ['ClassA', 'a1'],
        ['ClassB', 'b2'],
        ['ClassD', 'd1'],
      ]);

      const items = engine.diff(source, target, 'ApexClass');

      expect(items).toHaveLength(4);

      const byName = new Map(items.map((i) => [i.fullName, i]));
      expect(byName.get('ClassA')?.status).toBe('unchanged');
      expect(byName.get('ClassB')?.status).toBe('modified');
      expect(byName.get('ClassC')?.status).toBe('removed');
      expect(byName.get('ClassD')?.status).toBe('added');
    });

    it('should return an empty array when both maps are empty', () => {
      const items = engine.diff(new Map(), new Map(), 'CustomObject');
      expect(items).toEqual([]);
    });

    it('should set the correct componentType on each item', () => {
      const source = new Map([['MyFlow', 'v1']]);
      const target = new Map([['MyFlow', 'v2']]);

      const items = engine.diff(source, target, 'Flow');

      expect(items[0].componentType).toBe('Flow');
    });

    it('should mark added items as deployable', () => {
      const source = new Map<string, string>();
      const target = new Map([['New', 'val']]);

      const items = engine.diff(source, target, 'CustomLabel');
      expect(items[0].deployable).toBe(true);
    });

    it('should mark unchanged items as not deployable', () => {
      const source = new Map([['Same', 'val']]);
      const target = new Map([['Same', 'val']]);

      const items = engine.diff(source, target, 'CustomLabel');
      expect(items[0].deployable).toBe(false);
    });

    it('should assign breaking severity to removed critical types', () => {
      const source = new Map([['MyTrigger', 'code']]);
      const target = new Map<string, string>();

      const items = engine.diff(source, target, 'ApexTrigger');
      expect(items[0].severity).toBe('breaking');
    });

    it('should assign warning severity to modified non-critical types', () => {
      const source = new Map([['MyLayout', 'v1']]);
      const target = new Map([['MyLayout', 'v2']]);

      const items = engine.diff(source, target, 'Layout');
      expect(items[0].severity).toBe('warning');
    });
  });

  describe('diffFields', () => {
    it('should detect added fields', () => {
      const diffs = engine.diffFields({}, { newField: 'value' });

      expect(diffs).toHaveLength(1);
      expect(diffs[0].fieldPath).toBe('newField');
      expect(diffs[0].status).toBe('added');
      expect(diffs[0].sourceValue).toBe('');
      expect(diffs[0].targetValue).toBe('value');
    });

    it('should detect removed fields', () => {
      const diffs = engine.diffFields({ oldField: 'value' }, {});

      expect(diffs).toHaveLength(1);
      expect(diffs[0].fieldPath).toBe('oldField');
      expect(diffs[0].status).toBe('removed');
    });

    it('should detect modified fields', () => {
      const diffs = engine.diffFields({ field: 'old' }, { field: 'new' });

      expect(diffs).toHaveLength(1);
      expect(diffs[0].status).toBe('modified');
      expect(diffs[0].sourceValue).toBe('old');
      expect(diffs[0].targetValue).toBe('new');
    });

    it('should not include unchanged fields', () => {
      const diffs = engine.diffFields({ field: 'same' }, { field: 'same' });

      expect(diffs).toHaveLength(0);
    });

    it('should handle empty objects', () => {
      const diffs = engine.diffFields({}, {});
      expect(diffs).toEqual([]);
    });

    it('should handle multiple fields with mixed statuses', () => {
      const diffs = engine.diffFields(
        { kept: 'same', changed: 'old', removed: 'val' },
        { kept: 'same', changed: 'new', added: 'val' },
      );

      expect(diffs).toHaveLength(3);
      const byPath = new Map(diffs.map((d) => [d.fieldPath, d]));
      expect(byPath.get('changed')?.status).toBe('modified');
      expect(byPath.get('removed')?.status).toBe('removed');
      expect(byPath.get('added')?.status).toBe('added');
    });
  });

  describe('computeSummary', () => {
    it('should count items by status', () => {
      const items: CompareItem[] = [
        createItem('ApexClass', 'A', 'added'),
        createItem('ApexClass', 'B', 'removed'),
        createItem('ApexClass', 'C', 'modified'),
        createItem('ApexClass', 'D', 'unchanged'),
      ];

      const summary = engine.computeSummary(items);

      expect(summary.totalItems).toBe(4);
      expect(summary.added).toBe(1);
      expect(summary.removed).toBe(1);
      expect(summary.modified).toBe(1);
      expect(summary.unchanged).toBe(1);
    });

    it('should group changes by component type', () => {
      const items: CompareItem[] = [
        createItem('ApexClass', 'A', 'added'),
        createItem('ApexClass', 'B', 'removed'),
        createItem('Flow', 'C', 'modified'),
      ];

      const summary = engine.computeSummary(items);

      expect(summary.byType['ApexClass']).toEqual({ added: 1, removed: 1, modified: 0 });
      expect(summary.byType['Flow']).toEqual({ added: 0, removed: 0, modified: 1 });
    });

    it('should not include unchanged items in byType', () => {
      const items: CompareItem[] = [createItem('ApexClass', 'A', 'unchanged')];

      const summary = engine.computeSummary(items);

      expect(summary.byType['ApexClass']).toBeUndefined();
    });

    it('should return zero counts for an empty array', () => {
      const summary = engine.computeSummary([]);

      expect(summary.totalItems).toBe(0);
      expect(summary.added).toBe(0);
      expect(summary.removed).toBe(0);
      expect(summary.modified).toBe(0);
      expect(summary.unchanged).toBe(0);
      expect(summary.byType).toEqual({});
    });
  });

  describe('determineSeverity', () => {
    it('should return info for added items', () => {
      expect(DiffEngine.determineSeverity('added', 'ApexClass')).toBe('info');
    });

    it('should return info for unchanged items', () => {
      expect(DiffEngine.determineSeverity('unchanged', 'ApexClass')).toBe('info');
    });

    it('should return breaking for removed critical types', () => {
      expect(DiffEngine.determineSeverity('removed', 'ApexClass')).toBe('breaking');
      expect(DiffEngine.determineSeverity('removed', 'Flow')).toBe('breaking');
      expect(DiffEngine.determineSeverity('removed', 'ValidationRule')).toBe('breaking');
    });

    it('should return warning for modified non-critical types', () => {
      expect(DiffEngine.determineSeverity('modified', 'Layout')).toBe('warning');
      expect(DiffEngine.determineSeverity('modified', 'Report')).toBe('warning');
    });

    it('should return breaking for modified critical types', () => {
      expect(DiffEngine.determineSeverity('modified', 'ApexTrigger')).toBe('breaking');
      expect(DiffEngine.determineSeverity('modified', 'CustomObject')).toBe('breaking');
    });
  });

  describe('isDeployable', () => {
    it('should return true for added, removed, and modified', () => {
      expect(DiffEngine.isDeployable('added')).toBe(true);
      expect(DiffEngine.isDeployable('removed')).toBe(true);
      expect(DiffEngine.isDeployable('modified')).toBe(true);
    });

    it('should return false for unchanged', () => {
      expect(DiffEngine.isDeployable('unchanged')).toBe(false);
    });
  });
});

function createItem(
  componentType: MetadataComponentType,
  fullName: string,
  status: CompareItem['status'],
): CompareItem {
  return {
    componentType,
    fullName,
    status,
    severity: DiffEngine.determineSeverity(status, componentType),
    deployable: DiffEngine.isDeployable(status),
  };
}
