import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TeamConfigService } from './TeamConfigService';

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

describe('TeamConfigService', () => {
  let service: TeamConfigService;
  let configStore: ReturnType<typeof createMockConfigStore>;

  beforeEach(() => {
    configStore = createMockConfigStore();
    service = new TeamConfigService(configStore as never);
  });

  describe('share', () => {
    it('should generate a shareable bundle', () => {
      configStore.set('sync:mapping1', { field: 'Account' }, 'syncMappings');
      const result = service.share(['syncMappings'], 'TestUser');
      expect(result.success).toBe(true);
      expect(result.bundle).toBeTruthy();
      expect(result.keysIncluded).toBe(1);
    });

    it('should return empty bundle for empty categories', () => {
      const result = service.share(['emptyCategory']);
      expect(result.success).toBe(true);
      expect(result.keysIncluded).toBe(0);
    });

    it('should include author name', () => {
      const result = service.share([], 'Alice');
      expect(result.success).toBe(true);
      const bundle = service.parseBundle(result.bundle!);
      expect(bundle.createdBy).toBe('Alice');
    });
  });

  describe('parseBundle', () => {
    it('should parse a valid bundle', () => {
      const result = service.share([]);
      const bundle = service.parseBundle(result.bundle!);
      expect(bundle.version).toBe('1.0.0');
      expect(bundle.createdAt).toBeTruthy();
    });

    it('should throw on invalid base64', () => {
      expect(() => service.parseBundle('not-base64!!!')).toThrow();
    });

    it('should throw on corrupted checksum', () => {
      const result = service.share([]);
      const json = TeamConfigService.fromBase64(result.bundle!);
      const obj = JSON.parse(json);
      obj.checksum = 'corrupted';
      const tampered = TeamConfigService.toBase64(JSON.stringify(obj));
      expect(() => service.parseBundle(tampered)).toThrow('checksum mismatch');
    });
  });

  describe('import', () => {
    it('should import new keys', () => {
      configStore.set('sync:mapping1', { field: 'Account' }, 'syncMappings');
      const shared = service.share(['syncMappings']);

      // Create a fresh service with empty store
      const freshStore = createMockConfigStore();
      const freshService = new TeamConfigService(freshStore as never);
      const result = freshService.import(shared.bundle!, 'keep-remote');

      expect(result.success).toBe(true);
      expect(result.keysImported).toBe(1);
    });

    it('should skip identical keys', () => {
      configStore.set('sync:mapping1', { field: 'Account' }, 'syncMappings');
      const shared = service.share(['syncMappings']);

      // Import into same store (same data)
      const result = service.import(shared.bundle!, 'keep-remote');
      expect(result.success).toBe(true);
      expect(result.keysSkipped).toBe(1);
    });

    it('should keep local values with keep-local strategy', () => {
      configStore.set('sync:mapping1', { field: 'Account' }, 'syncMappings');
      const shared = service.share(['syncMappings']);

      // Modify local value
      configStore.set('sync:mapping1', { field: 'Contact' }, 'syncMappings');
      const result = service.import(shared.bundle!, 'keep-local');
      expect(result.success).toBe(true);
      expect(result.keysSkipped).toBe(1);
      expect(result.conflicts).toHaveLength(1);
    });

    it('should overwrite local values with keep-remote strategy', () => {
      configStore.set('sync:mapping1', { field: 'Account' }, 'syncMappings');
      const shared = service.share(['syncMappings']);

      configStore.set('sync:mapping1', { field: 'Contact' }, 'syncMappings');
      const result = service.import(shared.bundle!, 'keep-remote');
      expect(result.success).toBe(true);
      expect(result.keysImported).toBe(1);
    });

    it('should detect conflicts with merge strategy', () => {
      configStore.set('sync:mapping1', { field: 'Account' }, 'syncMappings');
      const shared = service.share(['syncMappings']);

      configStore.set('sync:mapping1', { field: 'Contact' }, 'syncMappings');
      const result = service.import(shared.bundle!, 'merge');
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].key).toBe('sync:mapping1');
    });

    it('should return error for invalid bundle', () => {
      const result = service.import('invalid-bundle', 'keep-remote');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('detectConflicts', () => {
    it('should detect conflicts between bundle and local config', () => {
      configStore.set('sync:mapping1', { field: 'Account' }, 'syncMappings');
      const shared = service.share(['syncMappings']);

      configStore.set('sync:mapping1', { field: 'Contact' }, 'syncMappings');
      const conflicts = service.detectConflicts(shared.bundle!);
      expect(conflicts).toHaveLength(1);
    });

    it('should return empty array when no conflicts', () => {
      configStore.set('sync:mapping1', { field: 'Account' }, 'syncMappings');
      const shared = service.share(['syncMappings']);
      const conflicts = service.detectConflicts(shared.bundle!);
      expect(conflicts).toHaveLength(0);
    });
  });

  describe('preview', () => {
    it('should return parsed bundle without applying', () => {
      const shared = service.share([]);
      const bundle = service.preview(shared.bundle!);
      expect(bundle.version).toBe('1.0.0');
    });
  });

  describe('computeChecksum', () => {
    it('should produce consistent checksums', () => {
      const data = { key: 'value' };
      const c1 = TeamConfigService.computeChecksum(data);
      const c2 = TeamConfigService.computeChecksum(data);
      expect(c1).toBe(c2);
    });

    it('should produce different checksums for different data', () => {
      const c1 = TeamConfigService.computeChecksum({ a: 1 });
      const c2 = TeamConfigService.computeChecksum({ a: 2 });
      expect(c1).not.toBe(c2);
    });
  });

  describe('toBase64 / fromBase64', () => {
    it('should round-trip encode/decode', () => {
      const original = '{"test": true}';
      const encoded = TeamConfigService.toBase64(original);
      const decoded = TeamConfigService.fromBase64(encoded);
      expect(decoded).toBe(original);
    });
  });
});
