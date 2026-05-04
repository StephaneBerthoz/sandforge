import { describe, it, expect, vi } from 'vitest';
import { SchemaCheck } from './SchemaCheck';
import type { FetchSchemaFn, ObjectSchemaInfo } from './SchemaCheck';
import type { PreCheckConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['schema'],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createSchemaInfo(overrides?: Partial<ObjectSchemaInfo>): ObjectSchemaInfo {
  return {
    objectApiName: 'Account',
    requiredFields: ['Name'],
    mappedFields: ['Name'],
    validationRuleCount: 0,
    activeTriggerCount: 0,
    activeFlowCount: 0,
    duplicateRuleCount: 0,
    ...overrides,
  };
}

describe('SchemaCheck', () => {
  describe('check', () => {
    it('should return items for each schema aspect per object', async () => {
      const fetchFn: FetchSchemaFn = vi.fn().mockResolvedValue([createSchemaInfo()]);
      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items.length).toBeGreaterThanOrEqual(5);
    });

    it('should pass required fields when all are mapped', async () => {
      const fetchFn: FetchSchemaFn = vi.fn().mockResolvedValue([
        createSchemaInfo({
          requiredFields: ['Name', 'Industry'],
          mappedFields: ['Name', 'Industry', 'Phone'],
        }),
      ]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());
      const reqItem = items.find((i) => i.name.includes('Required fields'));

      expect(reqItem?.passed).toBe(true);
      expect(reqItem?.severity).toBe('info');
    });

    it('should fail when required fields are unmapped', async () => {
      const fetchFn: FetchSchemaFn = vi.fn().mockResolvedValue([
        createSchemaInfo({
          requiredFields: ['Name', 'Industry', 'Type'],
          mappedFields: ['Name'],
        }),
      ]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());
      const reqItem = items.find((i) => i.name.includes('Required fields'));

      expect(reqItem?.passed).toBe(false);
      expect(reqItem?.severity).toBe('error');
      expect(reqItem?.message).toContain('Industry');
      expect(reqItem?.message).toContain('Type');
    });

    it('should mark unmapped required fields as autoFixable', async () => {
      const fetchFn: FetchSchemaFn = vi.fn().mockResolvedValue([
        createSchemaInfo({
          requiredFields: ['Name', 'Industry'],
          mappedFields: ['Name'],
        }),
      ]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());
      const reqItem = items.find((i) => i.name.includes('Required fields'));

      expect(reqItem?.autoFixable).toBe(true);
      expect(reqItem?.fixDescription).toBeDefined();
    });

    it('should warn about active validation rules', async () => {
      const fetchFn: FetchSchemaFn = vi
        .fn()
        .mockResolvedValue([createSchemaInfo({ validationRuleCount: 3 })]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());
      const valItem = items.find((i) => i.name.includes('Validation rules'));

      expect(valItem?.severity).toBe('warning');
      expect(valItem?.message).toContain('3');
    });

    it('should pass validation rules when none exist', async () => {
      const fetchFn: FetchSchemaFn = vi
        .fn()
        .mockResolvedValue([createSchemaInfo({ validationRuleCount: 0 })]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());
      const valItem = items.find((i) => i.name.includes('Validation rules'));

      expect(valItem?.severity).toBe('info');
    });

    it('should warn about active triggers', async () => {
      const fetchFn: FetchSchemaFn = vi
        .fn()
        .mockResolvedValue([createSchemaInfo({ activeTriggerCount: 2 })]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());
      const trigItem = items.find((i) => i.name.includes('Active triggers'));

      expect(trigItem?.severity).toBe('warning');
      expect(trigItem?.message).toContain('2');
    });

    it('should warn about active flows', async () => {
      const fetchFn: FetchSchemaFn = vi
        .fn()
        .mockResolvedValue([createSchemaInfo({ activeFlowCount: 5 })]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());
      const flowItem = items.find((i) => i.name.includes('Active flows'));

      expect(flowItem?.severity).toBe('warning');
      expect(flowItem?.message).toContain('5');
    });

    it('should warn about duplicate rules', async () => {
      const fetchFn: FetchSchemaFn = vi
        .fn()
        .mockResolvedValue([createSchemaInfo({ duplicateRuleCount: 1 })]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());
      const dupItem = items.find((i) => i.name.includes('Duplicate rules'));

      expect(dupItem?.severity).toBe('warning');
      expect(dupItem?.message).toContain('1');
    });

    it('should handle multiple objects', async () => {
      const fetchFn: FetchSchemaFn = vi
        .fn()
        .mockResolvedValue([
          createSchemaInfo({ objectApiName: 'Account' }),
          createSchemaInfo({ objectApiName: 'Contact' }),
        ]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());

      const accountItems = items.filter((i) => i.name.includes('Account'));
      const contactItems = items.filter((i) => i.name.includes('Contact'));
      expect(accountItems.length).toBeGreaterThan(0);
      expect(contactItems.length).toBeGreaterThan(0);
    });

    it('should set all items to category schema', async () => {
      const fetchFn: FetchSchemaFn = vi.fn().mockResolvedValue([createSchemaInfo()]);
      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.category).toBe('schema');
      }
    });

    it('should call fetchSchema with orgId and operationConfig', async () => {
      const fetchFn: FetchSchemaFn = vi.fn().mockResolvedValue([]);
      const config = createConfig({
        targetOrgId: 'org-test',
        operationConfig: { objects: ['Lead'] },
      });

      const checker = new SchemaCheck(fetchFn);
      await checker.check(config);

      expect(fetchFn).toHaveBeenCalledWith('org-test', { objects: ['Lead'] });
    });

    it('should return empty array for no schemas', async () => {
      const fetchFn: FetchSchemaFn = vi.fn().mockResolvedValue([]);
      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toEqual([]);
    });

    it('should pass triggers check when count is zero', async () => {
      const fetchFn: FetchSchemaFn = vi
        .fn()
        .mockResolvedValue([createSchemaInfo({ activeTriggerCount: 0 })]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());
      const trigItem = items.find((i) => i.name.includes('Active triggers'));

      expect(trigItem?.severity).toBe('info');
      expect(trigItem?.passed).toBe(true);
    });

    it('should generate unique IDs across all items', async () => {
      const fetchFn: FetchSchemaFn = vi
        .fn()
        .mockResolvedValue([
          createSchemaInfo({ objectApiName: 'Account' }),
          createSchemaInfo({ objectApiName: 'Contact' }),
        ]);

      const checker = new SchemaCheck(fetchFn);
      const items = await checker.check(createConfig());

      const ids = new Set(items.map((i) => i.id));
      expect(ids.size).toBe(items.length);
    });
  });
});
