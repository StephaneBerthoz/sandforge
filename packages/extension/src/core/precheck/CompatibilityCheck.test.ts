import { describe, it, expect, vi } from 'vitest';
import { CompatibilityCheck } from './CompatibilityCheck';
import type { FetchCompatibilityFn, CompatibilityData } from './CompatibilityCheck';
import type { PreCheckConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['compatibility'],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createCompatData(overrides?: Partial<CompatibilityData>): CompatibilityData {
  return {
    apiVersion: '59.0',
    requiredApiVersion: '55.0',
    features: [],
    managedPackages: [],
    ...overrides,
  };
}

describe('CompatibilityCheck', () => {
  describe('check', () => {
    it('should return at least 1 item for API version check', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(createCompatData());
      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it('should pass API version when current meets requirement', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({ apiVersion: '60.0', requiredApiVersion: '55.0' })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const apiItem = items.find((i) => i.name === 'API Version');

      expect(apiItem?.passed).toBe(true);
      expect(apiItem?.severity).toBe('info');
    });

    it('should blocker when API version is too low', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({ apiVersion: '50.0', requiredApiVersion: '55.0' })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const apiItem = items.find((i) => i.name === 'API Version');

      expect(apiItem?.passed).toBe(false);
      expect(apiItem?.severity).toBe('blocker');
    });

    it('should pass when API version exactly matches', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({ apiVersion: '55.0', requiredApiVersion: '55.0' })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const apiItem = items.find((i) => i.name === 'API Version');

      expect(apiItem?.passed).toBe(true);
    });

    it('should pass when required feature is available', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({
          features: [{ featureName: 'BulkApi2', required: true, available: true }],
        })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const featureItem = items.find((i) => i.name === 'Feature: BulkApi2');

      expect(featureItem?.passed).toBe(true);
      expect(featureItem?.severity).toBe('info');
    });

    it('should blocker when required feature is not available', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({
          features: [{ featureName: 'BulkApi2', required: true, available: false }],
        })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const featureItem = items.find((i) => i.name === 'Feature: BulkApi2');

      expect(featureItem?.passed).toBe(false);
      expect(featureItem?.severity).toBe('blocker');
    });

    it('should warn when optional feature is not available', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({
          features: [{ featureName: 'CompositeApi', required: false, available: false }],
        })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const featureItem = items.find((i) => i.name === 'Feature: CompositeApi');

      expect(featureItem?.passed).toBe(true);
      expect(featureItem?.severity).toBe('warning');
    });

    it('should pass when managed package is compatible', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({
          managedPackages: [{
            namespace: 'npe01',
            name: 'NPSP',
            currentVersion: '3.200',
            requiredVersion: '3.100',
            isCompatible: true,
          }],
        })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const pkgItem = items.find((i) => i.name === 'Package: npe01');

      expect(pkgItem?.passed).toBe(true);
      expect(pkgItem?.severity).toBe('info');
    });

    it('should error when managed package is incompatible', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({
          managedPackages: [{
            namespace: 'npe01',
            name: 'NPSP',
            currentVersion: '2.50',
            requiredVersion: '3.100',
            isCompatible: false,
          }],
        })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const pkgItem = items.find((i) => i.name === 'Package: npe01');

      expect(pkgItem?.passed).toBe(false);
      expect(pkgItem?.severity).toBe('error');
    });

    it('should handle multiple features and packages', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({
          features: [
            { featureName: 'BulkApi2', required: true, available: true },
            { featureName: 'CompositeApi', required: false, available: true },
          ],
          managedPackages: [
            { namespace: 'ns1', name: 'Pkg1', currentVersion: '1.0', requiredVersion: '1.0', isCompatible: true },
            { namespace: 'ns2', name: 'Pkg2', currentVersion: '2.0', requiredVersion: '2.0', isCompatible: true },
          ],
        })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toHaveLength(5);
    });

    it('should set all items to category compatibility', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({
          features: [{ featureName: 'BulkApi2', required: true, available: true }],
        })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.category).toBe('compatibility');
      }
    });

    it('should call fetchCompatibility with correct parameters', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(createCompatData());
      const config = createConfig({
        targetOrgId: 'org-test',
        operationConfig: { apiVersion: '59.0' },
      });

      const checker = new CompatibilityCheck(fetchFn);
      await checker.check(config);

      expect(fetchFn).toHaveBeenCalledWith('org-test', { apiVersion: '59.0' });
    });

    it('should mark all items as not autoFixable', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({
          features: [{ featureName: 'Test', required: true, available: false }],
        })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.autoFixable).toBe(false);
      }
    });

    it('should generate unique IDs for each item', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({
          features: [
            { featureName: 'F1', required: true, available: true },
            { featureName: 'F2', required: true, available: true },
          ],
        })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());

      const ids = new Set(items.map((i) => i.id));
      expect(ids.size).toBe(items.length);
    });

    it('should include version info in API version message', async () => {
      const fetchFn: FetchCompatibilityFn = vi.fn().mockResolvedValue(
        createCompatData({ apiVersion: '61.0', requiredApiVersion: '58.0' })
      );

      const checker = new CompatibilityCheck(fetchFn);
      const items = await checker.check(createConfig());
      const apiItem = items.find((i) => i.name === 'API Version');

      expect(apiItem?.message).toContain('61.0');
      expect(apiItem?.message).toContain('58.0');
    });
  });
});
