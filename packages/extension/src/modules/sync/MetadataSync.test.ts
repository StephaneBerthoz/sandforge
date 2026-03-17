import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataSync } from './MetadataSync';
import type { MetadataSyncDeps, MetadataComponent, DeployOutcome } from './MetadataSync';

function createDeps(overrides?: Partial<MetadataSyncDeps>): MetadataSyncDeps {
  return {
    fetchMetadata: vi.fn().mockResolvedValue([]),
    deployMetadata: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createComponent(overrides?: Partial<MetadataComponent>): MetadataComponent {
  return {
    fullName: 'MyClass',
    type: 'ApexClass',
    content: 'public class MyClass {}',
    ...overrides,
  };
}

describe('MetadataSync', () => {
  let deps: MetadataSyncDeps;
  let service: MetadataSync;

  beforeEach(() => {
    deps = createDeps();
    service = new MetadataSync(deps);
  });

  describe('sync', () => {
    it('should fetch metadata from source org', async () => {
      await service.sync('source-org', 'target-org', ['ApexClass']);

      expect(deps.fetchMetadata).toHaveBeenCalledWith('source-org', ['ApexClass']);
    });

    it('should deploy fetched components to target org', async () => {
      const components = [createComponent()];
      deps = createDeps({
        fetchMetadata: vi.fn().mockResolvedValue(components),
        deployMetadata: vi.fn().mockResolvedValue([
          { fullName: 'MyClass', success: true },
        ]),
      });
      service = new MetadataSync(deps);

      await service.sync('source-org', 'target-org', ['ApexClass']);

      expect(deps.deployMetadata).toHaveBeenCalledWith('target-org', components);
    });

    it('should return success count for successful deployments', async () => {
      const outcomes: DeployOutcome[] = [
        { fullName: 'ClassA', success: true },
        { fullName: 'ClassB', success: true },
      ];
      deps = createDeps({
        fetchMetadata: vi.fn().mockResolvedValue([
          createComponent({ fullName: 'ClassA' }),
          createComponent({ fullName: 'ClassB' }),
        ]),
        deployMetadata: vi.fn().mockResolvedValue(outcomes),
      });
      service = new MetadataSync(deps);

      const result = await service.sync('src', 'tgt', ['ApexClass']);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.processed).toBe(2);
    });

    it('should return failure count and errors for failed deployments', async () => {
      const outcomes: DeployOutcome[] = [
        { fullName: 'ClassA', success: true },
        { fullName: 'ClassB', success: false, error: 'Compilation error' },
      ];
      deps = createDeps({
        fetchMetadata: vi.fn().mockResolvedValue([
          createComponent({ fullName: 'ClassA' }),
          createComponent({ fullName: 'ClassB' }),
        ]),
        deployMetadata: vi.fn().mockResolvedValue(outcomes),
      });
      service = new MetadataSync(deps);

      const result = await service.sync('src', 'tgt', ['ApexClass']);

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toEqual(['ClassB: Compilation error']);
    });

    it('should return empty result when no types are provided', async () => {
      const result = await service.sync('src', 'tgt', []);

      expect(result.processed).toBe(0);
      expect(deps.fetchMetadata).not.toHaveBeenCalled();
    });

    it('should return empty result when no components are found', async () => {
      deps = createDeps({
        fetchMetadata: vi.fn().mockResolvedValue([]),
      });
      service = new MetadataSync(deps);

      const result = await service.sync('src', 'tgt', ['ApexClass']);

      expect(result.processed).toBe(0);
      expect(deps.deployMetadata).not.toHaveBeenCalled();
    });

    it('should handle multiple metadata types', async () => {
      await service.sync('src', 'tgt', ['ApexClass', 'ApexTrigger', 'CustomObject']);

      expect(deps.fetchMetadata).toHaveBeenCalledWith('src', [
        'ApexClass',
        'ApexTrigger',
        'CustomObject',
      ]);
    });

    it('should set objectApiName to Metadata in the result', async () => {
      const result = await service.sync('src', 'tgt', []);

      expect(result.objectApiName).toBe('Metadata');
    });

    it('should set operation to upsert in the result', async () => {
      const result = await service.sync('src', 'tgt', []);

      expect(result.operation).toBe('upsert');
    });

    it('should include error details with component names', async () => {
      const outcomes: DeployOutcome[] = [
        { fullName: 'BadTrigger', success: false, error: 'Missing reference' },
      ];
      deps = createDeps({
        fetchMetadata: vi.fn().mockResolvedValue([
          createComponent({ fullName: 'BadTrigger', type: 'ApexTrigger' }),
        ]),
        deployMetadata: vi.fn().mockResolvedValue(outcomes),
      });
      service = new MetadataSync(deps);

      const result = await service.sync('src', 'tgt', ['ApexTrigger']);

      expect(result.errors[0]).toContain('BadTrigger');
      expect(result.errors[0]).toContain('Missing reference');
    });

    it('should handle failed outcome without error message', async () => {
      const outcomes: DeployOutcome[] = [
        { fullName: 'ClassA', success: false },
      ];
      deps = createDeps({
        fetchMetadata: vi.fn().mockResolvedValue([createComponent()]),
        deployMetadata: vi.fn().mockResolvedValue(outcomes),
      });
      service = new MetadataSync(deps);

      const result = await service.sync('src', 'tgt', ['ApexClass']);

      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(0);
    });
  });
});
