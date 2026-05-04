import type { CompareConfig, CompareResult, CompareItem } from '@sandforge/shared';
import type { MetadataCompare } from './MetadataCompare';
import type { ConfigCompare } from './ConfigCompare';
import type { PermissionCompare } from './PermissionCompare';
import type { DataCompare } from './DataCompare';
import type { DiffEngine } from './DiffEngine';
import type { CoreServices } from '../../services.js';

/** Dependencies required by the CompareOrchestrator */
export interface CompareDependencies {
  metadataCompare: MetadataCompare;
  configCompare: ConfigCompare;
  permissionCompare: PermissionCompare;
  dataCompare: DataCompare;
  diffEngine: DiffEngine;
  /**
   * Injected cross-cutting adapters (telemetry, storage, salesforce, fs).
   * Provided by the composition root (`services.ts`). Optional to preserve
   * backward compatibility with tests that pass a narrow deps shape.
   */
  services?: CoreServices;
}

/**
 * Central orchestrator that coordinates all comparison sub-services.
 * Delegates to the appropriate comparators based on the CompareConfig mode
 * and aggregates results into a unified CompareResult.
 */
export class CompareOrchestrator {
  private readonly deps: CompareDependencies;
  private readonly results: Map<string, CompareResult> = new Map();

  constructor(deps: CompareDependencies) {
    this.deps = deps;
  }

  /**
   * Execute a full comparison based on the provided configuration.
   * Dispatches to sub-services according to the configured mode.
   */
  async execute(config: CompareConfig): Promise<CompareResult> {
    const startTime = Date.now();
    const allDiffs: CompareItem[] = [];

    if (config.mode === 'metadata' || config.mode === 'full') {
      const metadataDiffs = await this.deps.metadataCompare.compare(
        config.sourceOrgId,
        config.targetOrgId,
        config.componentTypes,
      );
      allDiffs.push(...metadataDiffs);
    }

    if (config.mode === 'config' || config.mode === 'full') {
      const configDiffs = await this.deps.configCompare.compare(
        config.sourceOrgId,
        config.targetOrgId,
      );
      allDiffs.push(...configDiffs);
    }

    if (config.mode === 'permissions' || config.mode === 'full') {
      const permDiffs = await this.deps.permissionCompare.compare(
        config.sourceOrgId,
        config.targetOrgId,
      );
      allDiffs.push(...permDiffs);
    }

    if (config.mode === 'data' || config.mode === 'full') {
      const objectFilter = config.objectFilter ?? [];
      for (const objectName of objectFilter) {
        const dataDiffs = await this.deps.dataCompare.compare(
          config.sourceOrgId,
          config.targetOrgId,
          objectName,
          'Id',
        );
        allDiffs.push(...dataDiffs);
      }
    }

    const summary = this.deps.diffEngine.computeSummary(allDiffs);
    const duration = Date.now() - startTime;

    const result: CompareResult = {
      configId: config.id,
      sourceOrgId: config.sourceOrgId,
      targetOrgId: config.targetOrgId,
      mode: config.mode,
      summary,
      diffs: allDiffs,
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
