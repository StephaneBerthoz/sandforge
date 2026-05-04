import { describe, it, expect, beforeEach } from 'vitest';
import { CrossObjectConsistency } from './CrossObjectConsistency';
import type { SeedDataPlan } from '@sandforge/shared';

function createPlan(overrides?: Partial<SeedDataPlan>): SeedDataPlan {
  return {
    objects: [
      {
        objectApiName: 'Account',
        recordCount: 2,
        sampleRecords: [],
        dependsOn: [],
      },
      {
        objectApiName: 'Contact',
        recordCount: 3,
        sampleRecords: [],
        dependsOn: ['Account'],
      },
    ],
    totalRecords: 5,
    estimatedApiCalls: 2,
    estimatedDuration: 300,
    grappeRecommended: false,
    ...overrides,
  };
}

function createGeneratedData(): Map<string, Record<string, unknown>[]> {
  const data = new Map<string, Record<string, unknown>[]>();
  data.set('Account', [
    { Id: '001A', Name: 'Acme' },
    { Id: '001B', Name: 'Globex' },
  ]);
  data.set('Contact', [
    { Id: '003A', Name: 'Alice', AccountId: '001A' },
    { Id: '003B', Name: 'Bob', AccountId: '001B' },
    { Id: '003C', Name: 'Charlie', AccountId: '001A' },
  ]);
  return data;
}

describe('CrossObjectConsistency', () => {
  let checker: CrossObjectConsistency;

  beforeEach(() => {
    checker = new CrossObjectConsistency();
  });

  describe('validate', () => {
    it('should return consistent for valid data', () => {
      const result = checker.validate(createPlan(), createGeneratedData());
      expect(result.consistent).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect orphaned references', () => {
      const data = createGeneratedData();
      data.set('Contact', [{ Id: '003A', Name: 'Alice', AccountId: 'INVALID_ID' }]);

      const result = checker.validate(createPlan(), data);
      expect(result.consistent).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].message).toContain('not found');
    });

    it('should detect missing dependency data', () => {
      const data = new Map<string, Record<string, unknown>[]>();
      data.set('Contact', [{ Id: '003A', Name: 'Alice', AccountId: '001A' }]);

      const result = checker.validate(createPlan(), data);
      expect(result.consistent).toBe(false);
      expect(result.issues.some((i) => i.message.includes('no generated records'))).toBe(true);
    });

    it('should handle objects with no dependencies', () => {
      const plan: SeedDataPlan = {
        objects: [{ objectApiName: 'Lead', recordCount: 5, sampleRecords: [], dependsOn: [] }],
        totalRecords: 5,
        estimatedApiCalls: 1,
        estimatedDuration: 150,
        grappeRecommended: false,
      };

      const data = new Map<string, Record<string, unknown>[]>();
      data.set('Lead', [{ Id: '00Q1', Name: 'Test Lead' }]);

      const result = checker.validate(plan, data);
      expect(result.consistent).toBe(true);
    });

    it('should handle empty generated data', () => {
      const result = checker.validate(createPlan(), new Map());
      expect(result.consistent).toBe(false);
    });

    it('should not flag RecordTypeId as an orphaned reference', () => {
      const plan: SeedDataPlan = {
        objects: [{ objectApiName: 'Account', recordCount: 1, sampleRecords: [], dependsOn: [] }],
        totalRecords: 1,
        estimatedApiCalls: 1,
        estimatedDuration: 150,
        grappeRecommended: false,
      };

      const data = new Map<string, Record<string, unknown>[]>();
      data.set('Account', [{ Id: '001A', RecordTypeId: 'rt-1', Name: 'Test' }]);

      const result = checker.validate(plan, data);
      expect(result.consistent).toBe(true);
    });

    it('should handle multiple dependency violations', () => {
      const data = createGeneratedData();
      data.set('Contact', [
        { Id: '003A', Name: 'Alice', AccountId: 'BAD_1' },
        { Id: '003B', Name: 'Bob', AccountId: 'BAD_2' },
      ]);

      const result = checker.validate(createPlan(), data);
      expect(result.issues.length).toBe(2);
    });

    it('should report correct source and target objects in issues', () => {
      const data = createGeneratedData();
      data.set('Contact', [{ Id: '003A', Name: 'Alice', AccountId: 'INVALID' }]);

      const result = checker.validate(createPlan(), data);
      expect(result.issues[0].sourceObject).toBe('Contact');
      expect(result.issues[0].targetObject).toBe('Account');
    });

    it('should handle objects with no records in generated data', () => {
      const data = createGeneratedData();
      data.set('Contact', []);

      const result = checker.validate(createPlan(), data);
      expect(result.consistent).toBe(true);
    });

    it('should handle records without Id field', () => {
      const data = new Map<string, Record<string, unknown>[]>();
      data.set('Account', [{ Name: 'No ID Account' }]);
      data.set('Contact', [{ Name: 'Alice', AccountId: 'some-id' }]);

      const result = checker.validate(createPlan(), data);
      expect(result.consistent).toBe(false);
    });

    it('should handle plan with no objects', () => {
      const plan: SeedDataPlan = {
        objects: [],
        totalRecords: 0,
        estimatedApiCalls: 0,
        estimatedDuration: 0,
        grappeRecommended: false,
      };
      const result = checker.validate(plan, new Map());
      expect(result.consistent).toBe(true);
    });
  });
});
