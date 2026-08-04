import { describe, it, expect, beforeEach } from 'vitest';
import { DataPlanBuilder, resolveInsertOrder } from './DataPlanBuilder';
import type { SeedTemplate, SeedObjectConfig } from '@sandforge/shared';

function createTemplate(objects: SeedObjectConfig[]): SeedTemplate {
  return {
    id: 'tpl-1',
    name: 'Test',
    description: 'Test template',
    version: 1,
    strategy: 'faker',
    objects,
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function createObject(
  name: string,
  recordCount: number,
  fieldRules: SeedObjectConfig['fieldRules'] = [],
  batchSize = 200,
): SeedObjectConfig {
  return {
    objectApiName: name,
    recordCount,
    fieldRules,
    excludedFields: [],
    insertOrder: 0,
    batchSize,
  };
}

describe('DataPlanBuilder', () => {
  let builder: DataPlanBuilder;

  beforeEach(() => {
    builder = new DataPlanBuilder();
  });

  describe('build', () => {
    it('should calculate total records across all objects', () => {
      const template = createTemplate([createObject('Account', 100), createObject('Contact', 200)]);
      const plan = builder.build(template);
      expect(plan.totalRecords).toBe(300);
    });

    it('should calculate API calls based on batch sizes', () => {
      const template = createTemplate([createObject('Account', 500, [], 200)]);
      const plan = builder.build(template);
      expect(plan.estimatedApiCalls).toBe(3);
    });

    it('should estimate duration from API calls', () => {
      const template = createTemplate([createObject('Account', 200, [], 200)]);
      const plan = builder.build(template);
      expect(plan.estimatedDuration).toBe(150);
    });

    it('should recommend grappe mode for large operations', () => {
      const template = createTemplate([createObject('Account', 15000)]);
      const plan = builder.build(template);
      expect(plan.grappeRecommended).toBe(true);
    });

    it('should not recommend grappe mode for small operations', () => {
      const template = createTemplate([createObject('Account', 100)]);
      const plan = builder.build(template);
      expect(plan.grappeRecommended).toBe(false);
    });

    it('should generate sample records for each object', () => {
      const template = createTemplate([
        createObject('Account', 50, [
          { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Acme' } },
        ]),
      ]);
      const plan = builder.build(template);
      expect(plan.objects[0].sampleRecords.length).toBeGreaterThan(0);
      expect(plan.objects[0].sampleRecords[0]).toEqual({ Name: 'Acme' });
    });

    it('should limit sample records to 3', () => {
      const template = createTemplate([
        createObject('Account', 100, [
          { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } },
        ]),
      ]);
      const plan = builder.build(template);
      expect(plan.objects[0].sampleRecords).toHaveLength(3);
    });

    it('should resolve dependencies from reference fields', () => {
      const template = createTemplate([
        createObject('Contact', 50, [
          {
            fieldApiName: 'AccountId',
            ruleType: 'reference',
            config: { referenceObject: 'Account' },
          },
        ]),
        createObject('Account', 10),
      ]);
      const plan = builder.build(template);

      const contactPlan = plan.objects.find((o) => o.objectApiName === 'Contact');
      expect(contactPlan?.dependsOn).toContain('Account');
    });

    it('should handle default batch size when zero', () => {
      const template = createTemplate([createObject('Account', 400, [], 0)]);
      const plan = builder.build(template);
      expect(plan.estimatedApiCalls).toBe(2);
    });

    it('should handle empty template', () => {
      const template = createTemplate([]);
      const plan = builder.build(template);
      expect(plan.totalRecords).toBe(0);
      expect(plan.objects).toEqual([]);
    });

    it('should generate sample for sequence fields', () => {
      const template = createTemplate([
        createObject('Account', 5, [
          {
            fieldApiName: 'Code',
            ruleType: 'sequence',
            config: { sequenceStart: 100, sequenceStep: 10, sequencePrefix: 'ACC-' },
          },
        ]),
      ]);
      const plan = builder.build(template);
      expect(plan.objects[0].sampleRecords[0]).toEqual({ Code: 'ACC-100' });
      expect(plan.objects[0].sampleRecords[1]).toEqual({ Code: 'ACC-110' });
    });
  });

  describe('resolveInsertOrder', () => {
    it('should place dependencies before dependents', () => {
      const objects: SeedObjectConfig[] = [
        createObject('Contact', 50, [
          {
            fieldApiName: 'AccountId',
            ruleType: 'reference',
            config: { referenceObject: 'Account' },
          },
        ]),
        createObject('Account', 10),
      ];

      const sorted = resolveInsertOrder(objects);
      const accountIndex = sorted.findIndex((o) => o.objectApiName === 'Account');
      const contactIndex = sorted.findIndex((o) => o.objectApiName === 'Contact');

      expect(accountIndex).toBeLessThan(contactIndex);
    });

    it('should handle objects with no dependencies', () => {
      const objects = [createObject('Account', 10), createObject('Lead', 20)];

      const sorted = resolveInsertOrder(objects);
      expect(sorted).toHaveLength(2);
    });

    it('should handle multi-level dependencies', () => {
      const objects: SeedObjectConfig[] = [
        createObject('OpportunityLineItem', 30, [
          {
            fieldApiName: 'OpportunityId',
            ruleType: 'reference',
            config: { referenceObject: 'Opportunity' },
          },
        ]),
        createObject('Opportunity', 20, [
          {
            fieldApiName: 'AccountId',
            ruleType: 'reference',
            config: { referenceObject: 'Account' },
          },
        ]),
        createObject('Account', 10),
      ];

      const sorted = resolveInsertOrder(objects);
      const names = sorted.map((o) => o.objectApiName);

      expect(names.indexOf('Account')).toBeLessThan(names.indexOf('Opportunity'));
      expect(names.indexOf('Opportunity')).toBeLessThan(names.indexOf('OpportunityLineItem'));
    });

    it('should return empty array for empty input', () => {
      expect(resolveInsertOrder([])).toEqual([]);
    });
  });
});
