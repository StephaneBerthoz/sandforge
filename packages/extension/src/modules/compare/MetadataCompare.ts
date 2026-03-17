import type { CompareItem, MetadataComponentType } from '@sandforge/shared';
import type { DiffEngine } from './DiffEngine';

/** Function signature for fetching metadata from a Salesforce org */
export type FetchMetadataFn = (
  orgId: string,
  componentType: MetadataComponentType
) => Promise<Map<string, string>>;

/**
 * Compares metadata components between two Salesforce orgs.
 * Delegates the actual diffing to the DiffEngine and aggregates
 * results across multiple component types.
 */
export class MetadataCompare {
  private readonly fetchMetadata: FetchMetadataFn;
  private readonly diffEngine: DiffEngine;

  constructor(fetchMetadata: FetchMetadataFn, diffEngine: DiffEngine) {
    this.fetchMetadata = fetchMetadata;
    this.diffEngine = diffEngine;
  }

  /**
   * Compare metadata between source and target orgs for the given component types.
   * Fetches metadata for each type from both orgs and produces a unified diff list.
   */
  async compare(
    sourceOrgId: string,
    targetOrgId: string,
    types: MetadataComponentType[]
  ): Promise<CompareItem[]> {
    const allItems: CompareItem[] = [];

    for (const componentType of types) {
      const [sourceMap, targetMap] = await Promise.all([
        this.fetchMetadata(sourceOrgId, componentType),
        this.fetchMetadata(targetOrgId, componentType),
      ]);

      const items = this.diffEngine.diff(sourceMap, targetMap, componentType);
      allItems.push(...items);
    }

    return allItems;
  }
}
