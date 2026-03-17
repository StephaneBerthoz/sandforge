import type {
  PreCheckConfig,
  PreCheckItem,
} from '@sandforge/shared';
import { randomUUID } from 'crypto';

/** Compatibility data for the target org */
export interface CompatibilityData {
  apiVersion: string;
  requiredApiVersion: string;
  features: FeatureAvailability[];
  managedPackages: ManagedPackageInfo[];
}

/** Feature availability in the org */
export interface FeatureAvailability {
  featureName: string;
  required: boolean;
  available: boolean;
}

/** Managed package version info */
export interface ManagedPackageInfo {
  namespace: string;
  name: string;
  currentVersion: string;
  requiredVersion: string;
  isCompatible: boolean;
}

/** Dependency: fetches compatibility data for the org */
export type FetchCompatibilityFn = (
  orgId: string,
  operationConfig: Record<string, unknown>
) => Promise<CompatibilityData>;

/**
 * Checks API version compatibility, feature availability,
 * and managed package version compatibility.
 */
export class CompatibilityCheck {
  private readonly fetchCompatibility: FetchCompatibilityFn;

  constructor(fetchCompatibility: FetchCompatibilityFn) {
    this.fetchCompatibility = fetchCompatibility;
  }

  /** Run all compatibility checks */
  async check(config: PreCheckConfig): Promise<PreCheckItem[]> {
    const data = await this.fetchCompatibility(
      config.targetOrgId,
      config.operationConfig
    );
    const items: PreCheckItem[] = [];

    items.push(this.checkApiVersion(data.apiVersion, data.requiredApiVersion));
    items.push(...this.checkFeatures(data.features));
    items.push(...this.checkManagedPackages(data.managedPackages));

    return items;
  }

  /** Check if the org API version meets the requirement */
  private checkApiVersion(current: string, required: string): PreCheckItem {
    const currentNum = parseFloat(current);
    const requiredNum = parseFloat(required);
    const passed = currentNum >= requiredNum;

    return {
      id: randomUUID(),
      category: 'compatibility',
      name: 'API Version',
      description: 'Checks if the org API version meets the minimum requirement',
      severity: passed ? 'info' : 'blocker',
      passed,
      message: passed
        ? `API version ${current} meets requirement (>= ${required})`
        : `API version ${current} is below required ${required}`,
      details: { currentVersion: current, requiredVersion: required },
      autoFixable: false,
    };
  }

  /** Check feature availability in the org */
  private checkFeatures(features: FeatureAvailability[]): PreCheckItem[] {
    return features.map((feature) => {
      const passed = feature.available || !feature.required;
      let severity: 'info' | 'warning' | 'blocker';

      if (feature.available) {
        severity = 'info';
      } else if (feature.required) {
        severity = 'blocker';
      } else {
        severity = 'warning';
      }

      return {
        id: randomUUID(),
        category: 'compatibility' as const,
        name: `Feature: ${feature.featureName}`,
        description: `Checks availability of ${feature.featureName}`,
        severity,
        passed,
        message: feature.available
          ? `Feature ${feature.featureName} is available`
          : `Feature ${feature.featureName} is not available${feature.required ? ' (required)' : ' (optional)'}`,
        details: { ...feature } as unknown as Record<string, unknown>,
        autoFixable: false,
      };
    });
  }

  /** Check managed package version compatibility */
  private checkManagedPackages(packages: ManagedPackageInfo[]): PreCheckItem[] {
    return packages.map((pkg) => {
      const passed = pkg.isCompatible;

      return {
        id: randomUUID(),
        category: 'compatibility' as const,
        name: `Package: ${pkg.namespace}`,
        description: `Checks version compatibility of ${pkg.name} (${pkg.namespace})`,
        severity: passed ? ('info' as const) : ('error' as const),
        passed,
        message: passed
          ? `${pkg.name} v${pkg.currentVersion} is compatible (requires >= ${pkg.requiredVersion})`
          : `${pkg.name} v${pkg.currentVersion} is incompatible (requires >= ${pkg.requiredVersion})`,
        details: { ...pkg } as unknown as Record<string, unknown>,
        autoFixable: false,
      };
    });
  }
}
