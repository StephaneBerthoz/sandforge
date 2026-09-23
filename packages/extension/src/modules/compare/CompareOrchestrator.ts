import type { CompareConfig, CompareResult } from '@sandforge/shared';
import type { MetadataCompare } from './MetadataCompare';
import type { DiffEngine } from './DiffEngine';
import type { CoreServices } from '../../services.js';

/** Dependencies required by the CompareOrchestrator */
export interface CompareDependencies {
  metadataCompare: MetadataCompare;
  diffEngine: DiffEngine;
  /**
   * Injected cross-cutting adapters (telemetry, storage, fs).
   * Provided by the composition root (`services.ts`). Optional to preserve
   * backward compatibility with tests that pass a narrow deps shape.
   */
  services?: CoreServices;
}

/**
 * Runs a comparison and gathers its result: the diff of every component, the
 * counts, and what the content comparison covered.
 */
export class CompareOrchestrator {
  private readonly deps: CompareDependencies;
  private readonly results: Map<string, CompareResult> = new Map();

  constructor(deps: CompareDependencies) {
    this.deps = deps;
  }

  /** Execute a comparison based on the provided configuration. */
  async execute(config: CompareConfig): Promise<CompareResult> {
    const startTime = Date.now();

    const { items: diffs, managedLeftOut } = await this.deps.metadataCompare.compare(
      config.sourceOrgId,
      config.targetOrgId,
      config.componentTypes,
      { includeManaged: config.includeManaged },
    );

    const summary = this.deps.diffEngine.computeSummary(diffs);
    const content = this.deps.diffEngine.computeCoverage(
      diffs,
      this.deps.metadataCompare.budget,
      managedLeftOut,
    );
    const duration = Date.now() - startTime;

    const result: CompareResult = {
      configId: config.id,
      sourceOrgId: config.sourceOrgId,
      targetOrgId: config.targetOrgId,
      mode: config.mode,
      summary,
      content,
      diffs,
      timestamp: new Date().toISOString(),
      duration,
    };

    this.results.set(config.id, result);

    return result;
  }

  /** Retrieve the last result for a given config ID */
  getLastResult(configId: string): CompareResult | undefined {
    return this.results.get(configId);
  }
}
