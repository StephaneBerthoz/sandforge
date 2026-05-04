import { describe, it, expect, beforeEach } from 'vitest';
import { DeploymentBuilder } from './DeploymentBuilder';
import type { CompareItem, MetadataComponentType } from '@sandforge/shared';

function createItem(
  componentType: MetadataComponentType,
  fullName: string,
  status: CompareItem['status'],
  deployable = true,
): CompareItem {
  return {
    componentType,
    fullName,
    status,
    severity: 'info',
    deployable,
  };
}

describe('DeploymentBuilder', () => {
  let builder: DeploymentBuilder;

  beforeEach(() => {
    builder = new DeploymentBuilder();
  });

  describe('build', () => {
    it('should create deploy action for added components', () => {
      const diffs = [createItem('ApexClass', 'NewClass', 'added')];
      const plan = builder.build(diffs);

      expect(plan.components).toHaveLength(1);
      expect(plan.components[0].action).toBe('deploy');
      expect(plan.components[0].reason).toContain('New component');
    });

    it('should create delete action for removed components', () => {
      const diffs = [createItem('ApexClass', 'OldClass', 'removed')];
      const plan = builder.build(diffs);

      expect(plan.components).toHaveLength(1);
      expect(plan.components[0].action).toBe('delete');
    });

    it('should create deploy action for modified components', () => {
      const diffs = [createItem('Flow', 'MyFlow', 'modified')];
      const plan = builder.build(diffs);

      expect(plan.components[0].action).toBe('deploy');
      expect(plan.components[0].reason).toContain('modified');
    });

    it('should skip unchanged components', () => {
      const diffs = [createItem('ApexClass', 'SameClass', 'unchanged')];
      const plan = builder.build(diffs);

      expect(plan.components).toHaveLength(0);
    });

    it('should skip non-deployable components', () => {
      const diffs = [createItem('ApexClass', 'Locked', 'modified', false)];
      const plan = builder.build(diffs);

      expect(plan.components).toHaveLength(1);
      expect(plan.components[0].action).toBe('skip');
    });

    it('should calculate estimated duration based on component types', () => {
      const diffs = [
        createItem('ApexClass', 'ClassA', 'modified'),
        createItem('CustomLabel', 'LabelA', 'added'),
      ];
      const plan = builder.build(diffs);

      expect(plan.estimatedDuration).toBe(13);
    });

    it('should not include skipped components in duration', () => {
      const diffs = [createItem('ApexClass', 'Skipped', 'unchanged')];
      const plan = builder.build(diffs);

      expect(plan.estimatedDuration).toBe(0);
    });

    it('should produce deployment order with CustomObject before ApexClass', () => {
      const diffs = [
        createItem('ApexClass', 'MyClass', 'added'),
        createItem('CustomObject', 'MyObject', 'added'),
      ];
      const plan = builder.build(diffs);

      const objectIdx = plan.order.indexOf('MyObject');
      const classIdx = plan.order.indexOf('MyClass');
      expect(objectIdx).toBeLessThan(classIdx);
    });

    it('should assess high risk for delete actions', () => {
      const diffs = [createItem('ApexClass', 'DeletedClass', 'removed')];
      const plan = builder.build(diffs);

      const risk = plan.risks.find((r) => r.component === 'DeletedClass');
      expect(risk).toBeDefined();
      expect(risk?.risk).toBe('high');
    });

    it('should assess high risk for deploying Apex changes', () => {
      const diffs = [createItem('ApexTrigger', 'MyTrigger', 'modified')];
      const plan = builder.build(diffs);

      const risk = plan.risks.find((r) => r.component === 'MyTrigger');
      expect(risk).toBeDefined();
      expect(risk?.risk).toBe('high');
    });

    it('should assess medium risk for profile changes', () => {
      const diffs = [createItem('Profile', 'Admin', 'modified')];
      const plan = builder.build(diffs);

      const risk = plan.risks.find((r) => r.component === 'Admin');
      expect(risk).toBeDefined();
      expect(risk?.risk).toBe('medium');
    });

    it('should not add risk for low-risk component types', () => {
      const diffs = [createItem('CustomLabel', 'Label1', 'added')];
      const plan = builder.build(diffs);

      expect(plan.risks).toHaveLength(0);
    });

    it('should exclude skipped components from the order', () => {
      const diffs = [
        createItem('ApexClass', 'Active', 'modified'),
        createItem('ApexClass', 'Inactive', 'unchanged'),
      ];
      const plan = builder.build(diffs);

      expect(plan.order).toContain('Active');
      expect(plan.order).not.toContain('Inactive');
    });

    it('should handle empty diffs', () => {
      const plan = builder.build([]);

      expect(plan.components).toHaveLength(0);
      expect(plan.estimatedDuration).toBe(0);
      expect(plan.risks).toHaveLength(0);
      expect(plan.order).toHaveLength(0);
    });
  });

  describe('addComponent', () => {
    it('should add a component to the plan', () => {
      builder.build([]);
      builder.addComponent({
        componentType: 'ApexClass',
        fullName: 'ManualClass',
        action: 'deploy',
        reason: 'Manual addition',
      });

      expect(builder.getComponents()).toHaveLength(1);
      expect(builder.getComponents()[0].fullName).toBe('ManualClass');
    });

    it('should replace an existing component with the same fullName', () => {
      builder.build([createItem('ApexClass', 'MyClass', 'added')]);
      builder.addComponent({
        componentType: 'ApexClass',
        fullName: 'MyClass',
        action: 'skip',
        reason: 'Overridden',
      });

      const components = builder.getComponents();
      expect(components).toHaveLength(1);
      expect(components[0].action).toBe('skip');
    });
  });

  describe('removeComponent', () => {
    it('should remove a component by fullName', () => {
      builder.build([createItem('ApexClass', 'MyClass', 'added')]);
      builder.removeComponent('MyClass');

      expect(builder.getComponents()).toHaveLength(0);
    });

    it('should not throw when removing a non-existent component', () => {
      builder.build([]);
      expect(() => builder.removeComponent('NonExistent')).not.toThrow();
    });
  });

  describe('reorder', () => {
    it('should reorder components according to provided order', () => {
      builder.build([
        createItem('ApexClass', 'ClassA', 'added'),
        createItem('Flow', 'FlowB', 'added'),
        createItem('Layout', 'LayoutC', 'added'),
      ]);

      builder.reorder(['LayoutC', 'FlowB', 'ClassA']);

      const components = builder.getComponents();
      expect(components[0].fullName).toBe('LayoutC');
      expect(components[1].fullName).toBe('FlowB');
      expect(components[2].fullName).toBe('ClassA');
    });

    it('should place unlisted components after listed ones', () => {
      builder.build([
        createItem('ApexClass', 'ClassA', 'added'),
        createItem('Flow', 'FlowB', 'added'),
      ]);

      builder.reorder(['FlowB']);

      const components = builder.getComponents();
      expect(components[0].fullName).toBe('FlowB');
      expect(components[1].fullName).toBe('ClassA');
    });
  });
});
