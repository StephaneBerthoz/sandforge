import { describe, it, expect, vi } from 'vitest';
import { AutoFixer } from './AutoFixer';
import type { FixHandlerMap } from './AutoFixer';
import type { PreCheckConfig, PreCheckItem } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['schema'],
    skipWarnings: false,
    autoFix: true,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createItem(overrides?: Partial<PreCheckItem>): PreCheckItem {
  return {
    id: 'test-id-1',
    category: 'schema',
    name: 'Test Check',
    description: 'A test check item',
    severity: 'error',
    passed: false,
    message: 'Test failed',
    autoFixable: true,
    fixDescription: 'Auto-fix available',
    ...overrides,
  };
}

describe('AutoFixer', () => {
  describe('fix', () => {
    it('should fix autoFixable items with a registered handler', async () => {
      const fixedItem = createItem({ passed: true, message: 'Fixed' });
      const handlers: FixHandlerMap = {
        schema: vi.fn().mockResolvedValue(fixedItem),
      };

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix([createItem()], createConfig());

      expect(result.fixed).toHaveLength(1);
      expect(result.fixed[0].passed).toBe(true);
      expect(result.failed).toHaveLength(0);
    });

    it('should skip items that already passed', async () => {
      const handlers: FixHandlerMap = {
        schema: vi.fn(),
      };

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix([createItem({ passed: true })], createConfig());

      expect(result.fixed).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(handlers.schema).not.toHaveBeenCalled();
    });

    it('should skip items that are not autoFixable', async () => {
      const handlers: FixHandlerMap = {
        schema: vi.fn(),
      };

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix([createItem({ autoFixable: false })], createConfig());

      expect(result.fixed).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it('should fail when no handler is registered for category', async () => {
      const handlers: FixHandlerMap = {};

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix([createItem()], createConfig());

      expect(result.fixed).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toContain('No fix handler');
      expect(result.failed[0].error).toContain('schema');
    });

    it('should handle handler throwing an error', async () => {
      const handlers: FixHandlerMap = {
        schema: vi.fn().mockRejectedValue(new Error('Fix failed: timeout')),
      };

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix([createItem()], createConfig());

      expect(result.fixed).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toBe('Fix failed: timeout');
    });

    it('should handle handler throwing non-Error', async () => {
      const handlers: FixHandlerMap = {
        schema: vi.fn().mockRejectedValue('string error'),
      };

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix([createItem()], createConfig());

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toBe('string error');
    });

    it('should fix multiple items with the same handler', async () => {
      const fixedItem = createItem({ passed: true });
      const handlers: FixHandlerMap = {
        schema: vi.fn().mockResolvedValue(fixedItem),
      };

      const items = [
        createItem({ id: 'item-1' }),
        createItem({ id: 'item-2' }),
        createItem({ id: 'item-3' }),
      ];

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix(items, createConfig());

      expect(result.fixed).toHaveLength(3);
      expect(handlers.schema).toHaveBeenCalledTimes(3);
    });

    it('should handle mixed categories', async () => {
      const fixedSchema = createItem({ category: 'schema', passed: true });
      const handlers: FixHandlerMap = {
        schema: vi.fn().mockResolvedValue(fixedSchema),
      };

      const items = [
        createItem({ id: 'item-1', category: 'schema' }),
        createItem({ id: 'item-2', category: 'permissions' }),
      ];

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix(items, createConfig());

      expect(result.fixed).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
    });

    it('should return empty result for empty input', async () => {
      const handlers: FixHandlerMap = {
        schema: vi.fn(),
      };

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix([], createConfig());

      expect(result.fixed).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it('should pass config to handler', async () => {
      const fixedItem = createItem({ passed: true });
      const handler = vi.fn().mockResolvedValue(fixedItem);
      const handlers: FixHandlerMap = {
        schema: handler,
      };

      const config = createConfig({ targetOrgId: 'org-fix-test' });
      const item = createItem();

      const fixer = new AutoFixer(handlers);
      await fixer.fix([item], config);

      expect(handler).toHaveBeenCalledWith(item, config);
    });

    it('should return original item in failure when handler fails', async () => {
      const handlers: FixHandlerMap = {
        schema: vi.fn().mockRejectedValue(new Error('Oops')),
      };

      const item = createItem({ id: 'fail-item', name: 'Failing Check' });
      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix([item], createConfig());

      expect(result.failed[0].item.id).toBe('fail-item');
      expect(result.failed[0].item.name).toBe('Failing Check');
    });

    it('should handle mix of success and failure in same category', async () => {
      let callCount = 0;
      const handlers: FixHandlerMap = {
        schema: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 2) {
            throw new Error('Second call fails');
          }
          return createItem({ passed: true });
        }),
      };

      const items = [
        createItem({ id: 'item-1' }),
        createItem({ id: 'item-2' }),
        createItem({ id: 'item-3' }),
      ];

      const fixer = new AutoFixer(handlers);
      const result = await fixer.fix(items, createConfig());

      expect(result.fixed).toHaveLength(2);
      expect(result.failed).toHaveLength(1);
    });
  });

  describe('hasHandler', () => {
    it('should return true for registered category', () => {
      const handlers: FixHandlerMap = {
        schema: vi.fn(),
      };

      const fixer = new AutoFixer(handlers);
      expect(fixer.hasHandler('schema')).toBe(true);
    });

    it('should return false for unregistered category', () => {
      const handlers: FixHandlerMap = {};

      const fixer = new AutoFixer(handlers);
      expect(fixer.hasHandler('permissions')).toBe(false);
    });
  });

  describe('getRegisteredCategories', () => {
    it('should return all registered categories', () => {
      const handlers: FixHandlerMap = {
        schema: vi.fn(),
        permissions: vi.fn(),
      };

      const fixer = new AutoFixer(handlers);
      const categories = fixer.getRegisteredCategories();

      expect(categories).toContain('schema');
      expect(categories).toContain('permissions');
      expect(categories).toHaveLength(2);
    });

    it('should return empty array when no handlers registered', () => {
      const fixer = new AutoFixer({});
      expect(fixer.getRegisteredCategories()).toEqual([]);
    });
  });
});
