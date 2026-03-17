import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GovernancePolicyStore } from './GovernancePolicyStore';
import type { GovernancePolicy } from './GovernanceEngine';

/** Minimal in-memory ConfigStore mock. */
function createMockConfigStore() {
  const data: Record<string, { value: string; category: string }> = {};

  return {
    get: vi.fn(<T>(key: string): T | undefined => {
      const entry = data[key];
      if (!entry) return undefined;
      return JSON.parse(entry.value) as T;
    }),
    set: vi.fn(<T>(key: string, value: T, category: string): void => {
      data[key] = { value: JSON.stringify(value), category };
    }),
    delete: vi.fn((key: string): boolean => {
      if (!(key in data)) return false;
      delete data[key];
      return true;
    }),
    has: vi.fn((key: string): boolean => key in data),
    getKeysByPrefix: vi.fn((prefix: string): string[] =>
      Object.keys(data).filter((k) => k.startsWith(prefix)),
    ),
    getByCategory: vi.fn((category: string): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(data)) {
        if (entry.category === category) {
          result[key] = JSON.parse(entry.value);
        }
      }
      return result;
    }),
    getAllKeys: vi.fn((): string[] => Object.keys(data)),
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  };
}

function createPolicy(overrides?: Partial<GovernancePolicy>): GovernancePolicy {
  return {
    id: 'pol-1',
    name: 'Test Policy',
    description: 'A test policy',
    rules: [
      {
        id: 'rule-1',
        name: 'API Usage',
        description: 'Check API usage',
        category: 'performance',
        condition: { metric: 'apiUsagePercent', operator: 'gt', threshold: 90 },
        remediation: 'Reduce API calls',
        enabled: true,
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('GovernancePolicyStore', () => {
  let store: GovernancePolicyStore;
  let configStore: ReturnType<typeof createMockConfigStore>;

  beforeEach(() => {
    configStore = createMockConfigStore();
    store = new GovernancePolicyStore(configStore as never);
  });

  describe('save / getById', () => {
    it('should save and retrieve a policy', () => {
      const policy = createPolicy();
      store.save(policy);
      const retrieved = store.getById('pol-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('Test Policy');
    });

    it('should return undefined for unknown policy', () => {
      expect(store.getById('unknown')).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('should return all policies', () => {
      store.save(createPolicy({ id: 'pol-1' }));
      store.save(createPolicy({ id: 'pol-2', name: 'Second Policy' }));
      const all = store.getAll();
      expect(all).toHaveLength(2);
    });

    it('should return empty array when no policies', () => {
      expect(store.getAll()).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('should delete a policy', () => {
      store.save(createPolicy());
      const deleted = store.delete('pol-1');
      expect(deleted).toBe(true);
      expect(store.getById('pol-1')).toBeUndefined();
    });

    it('should return false for non-existent policy', () => {
      expect(store.delete('unknown')).toBe(false);
    });
  });

  describe('exportPolicies / importPolicies', () => {
    it('should export policies as JSON', () => {
      store.save(createPolicy());
      const json = store.exportPolicies();
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    it('should import policies from JSON', () => {
      const policies = [createPolicy({ id: 'imported-1' })];
      const json = JSON.stringify(policies);
      const count = store.importPolicies(json);
      expect(count).toBe(1);
      expect(store.getById('imported-1')).toBeDefined();
    });

    it('should throw on invalid JSON', () => {
      expect(() => store.importPolicies('not-json')).toThrow();
    });

    it('should throw when JSON is not an array', () => {
      expect(() => store.importPolicies('{}')).toThrow('Expected an array');
    });

    it('should skip invalid entries during import', () => {
      const json = JSON.stringify([{ id: 'bad' }, createPolicy({ id: 'good' })]);
      const count = store.importPolicies(json);
      expect(count).toBe(1);
    });
  });

  describe('getDefaultTemplates', () => {
    it('should return three default templates', () => {
      const templates = GovernancePolicyStore.getDefaultTemplates();
      expect(templates).toHaveLength(3);
    });

    it('should include security, performance, and compliance templates', () => {
      const templates = GovernancePolicyStore.getDefaultTemplates();
      const names = templates.map((t) => t.name);
      expect(names).toContain('Security Policy');
      expect(names).toContain('Performance Policy');
      expect(names).toContain('Compliance Policy');
    });

    it('should have valid policies according to schema', () => {
      const templates = GovernancePolicyStore.getDefaultTemplates();
      for (const template of templates) {
        expect(template.rules.length).toBeGreaterThan(0);
        expect(template.id).toBeTruthy();
      }
    });
  });
});
