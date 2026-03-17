import type { CompareItem } from '@sandforge/shared';
import type { DiffEngine } from './DiffEngine';

/** Function signature for fetching org configuration */
export type FetchConfigFn = (orgId: string) => Promise<Map<string, string>>;

/**
 * Compares org-level configuration between two Salesforce orgs.
 * Covers org settings, features, custom settings values, and
 * other non-metadata configuration data.
 */
export class ConfigCompare {
  private readonly fetchConfig: FetchConfigFn;
  private readonly diffEngine: DiffEngine;

  constructor(fetchConfig: FetchConfigFn, diffEngine: DiffEngine) {
    this.fetchConfig = fetchConfig;
    this.diffEngine = diffEngine;
  }

  /**
   * Compare configuration between source and target orgs.
   * Returns a list of diff items representing configuration differences.
   */
  async compare(
    sourceOrgId: string,
    targetOrgId: string
  ): Promise<CompareItem[]> {
    const [sourceConfig, targetConfig] = await Promise.all([
      this.fetchConfig(sourceOrgId),
      this.fetchConfig(targetOrgId),
    ]);

    return this.diffEngine.diff(sourceConfig, targetConfig, 'CustomSetting');
  }
}
