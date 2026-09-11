/**
 * Dossier health check backed by the existing Forge graph discovery: a
 * complete graph, never a lame dossier. A root record is healthy when its
 * dependency graph is discovered completely: no truncation, and every expected object is
 * reached. This module only CONSUMES GraphDiscoveryService — Forge is
 * not modified.
 */

import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
import { GraphDiscoveryService, type DiscoveryOptions } from '../forge/GraphDiscoveryService.js';
import type { DossierHealth, DossierHealthChecker } from './CoverageMatrixSelector.js';

/** Narrow discovery-function shape (matches GraphDiscoveryService.discover). */
export type DiscoverFn = (config: ForgeConfig, options?: DiscoveryOptions) => Promise<ForgeGraph>;

/** Options for {@link ForgeGraphHealthChecker}. */
export interface ForgeGraphHealthCheckerOptions {
  /** API name of the root object — discovery config sanity anchor. */
  rootObject: string;
  /**
   * Objects that MUST be present in the discovered graph for the dossier
   * to be considered complete (e.g. mandatory child objects of the
   * business process).
   */
  expectedObjects: readonly string[];
  /**
   * When true, expected objects must also have at least one record
   * counted during discovery (default false — presence suffices).
   */
  requireNonEmptyObjects?: boolean;
  /** Discovery node cap override. */
  maxNodes?: number;
}

/**
 * Adapter: turns one Forge BFS discovery per candidate root into a
 * healthy/lame verdict for the CoverageMatrixSelector.
 */
export class ForgeGraphHealthChecker implements DossierHealthChecker {
  private readonly discover: DiscoverFn;

  constructor(
    discovery: GraphDiscoveryService | { discover: DiscoverFn },
    private readonly sourceOrgId: string,
    private readonly options: ForgeGraphHealthCheckerOptions,
  ) {
    this.discover = (config, opts) => discovery.discover(config, opts);
  }

  /** Run a full graph discovery for the candidate and judge completeness. */
  async check(rootRecordId: string): Promise<DossierHealth> {
    const config: ForgeConfig = {
      inputMode: 'record',
      recordId: rootRecordId,
      depth: 'full',
      sourceOrgId: this.sourceOrgId,
      // Discovery is read-only; the target org id is irrelevant to BFS but
      // required by the ForgeConfig shape.
      targetOrgId: this.sourceOrgId,
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    };

    let graph: ForgeGraph;
    try {
      graph = await this.discover(config, { maxNodes: this.options.maxNodes });
    } catch (error) {
      return {
        healthy: false,
        reason: `discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (graph.truncated === true) {
      return { healthy: false, reason: 'discovery truncated by node cap — graph incomplete' };
    }

    const nodesByObject = new Map(graph.nodes.map((n) => [n.objectApiName, n]));
    for (const expected of this.options.expectedObjects) {
      const node = nodesByObject.get(expected);
      if (!node) {
        return { healthy: false, reason: `expected object ${expected} missing from graph` };
      }
      if (this.options.requireNonEmptyObjects === true && node.recordCount === 0) {
        return { healthy: false, reason: `expected object ${expected} has no records` };
      }
    }

    return { healthy: true };
  }
}
